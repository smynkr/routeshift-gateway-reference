import {
  buildModelDetail,
  buildModelsList,
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  getModelPricing,
  isValidCapabilityIndices,
  type CapabilityIndices,
  type EffectiveCatalogDefinition,
} from '@routeshift/shared';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Read-only catalog surface. Everything here derives from the SAME public
 * catalog the unauthenticated `GET /v1/models` endpoint returns
 * (`buildModelsList(null)`): models with `public: false` are excluded and
 * unpriced models are omitted, so an agent sees exactly what a public
 * catalog consumer sees. No customer traffic, no money-path, no writes.
 */

export const RANK_CRITERIA = ['intelligence', 'price', 'context'] as const;
export type RankCriterion = (typeof RANK_CRITERIA)[number];

export const TOOLS: Tool[] = [
  {
    name: 'list_models',
    description:
      'List the public RouteShift model catalog: id, provider, context window, ' +
      'per-endpoint pricing (USD per token, as returned by /v1/models), and data ' +
      'policy per endpoint. Same visibility as the unauthenticated catalog. ' +
      'Intelligence tier and numeric per-million pricing are in rank_models.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_model',
    description:
      'Resolve a single catalog entry by canonical id or provider api_model_id ' +
      '(e.g. "gpt-5.4" or "claude-opus-4-6-20250219"). Same visibility as /v1/models/:id.',
    inputSchema: {
      type: 'object',
      properties: {
        model_id: { type: 'string', description: 'Canonical id or provider api_model_id' },
      },
      required: ['model_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'rank_models',
    description:
      'Deterministic ordering of the public chat-model catalog by real catalog fields ' +
      '(price, context window, capability indices, intelligence tier). This is a catalog-derived ' +
      'sort — NOT a live quality or benchmark score: RouteShift publishes no such score today. ' +
      'Sorts by each model\'s canonical-provider list pricing; endpoint-level pricing ' +
      '(including alternate providers such as Azure) is in list_models / get_model. ' +
      '`intelligence` sorts sourced intelligence indices >= 50 first (desc), then ' +
      'intelligence tier (desc) for everything else — a verified-weak index is never ' +
      'a penalty, mirroring the auto-router. Models without an intelligence ' +
      'tier sort last under `intelligence`. ' +
      '`auto_route: false` entries are visible but never auto-selected by the proxy.',
    inputSchema: {
      type: 'object',
      properties: {
        criterion: {
          type: 'string',
          enum: RANK_CRITERIA,
          default: 'intelligence',
          description:
            'intelligence: sourced intelligence index desc when >= 50, then intelligence tier desc, ' +
            'then input price asc. price: input price asc, then context desc. context: context window ' +
            'desc, then input price asc.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 25,
          description: 'Number of entries to return.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

export interface RankedModel {
  id: string;
  provider: string;
  context_length: number;
  intelligence_tier: number | null;
  auto_route: boolean;
  input_per_million: number;
  output_per_million: number;
  /** Sourced capability indices (with provenance), when the registry has them. */
  capability_indices?: CapabilityIndices;
}

function isRankCriterion(value: unknown): value is RankCriterion {
  return typeof value === 'string' && (RANK_CRITERIA as readonly string[]).includes(value);
}

/** Mirrors the public catalog projection's visibility + pricing gate
 *  (public !== false and a priced canonical row must exist — unpriced models
 *  are a catalog gap and are omitted from /v1/models too). The equivalence is
 *  pinned by a parity test against buildModelsList so the two cannot drift.
 *  Ranking operates over EFFECTIVE_DISPATCHABLE_CHAT_MODELS by default, which
 *  contains curated and generated explicit-only chat models but no embeddings.
 *  Embeddings live in the separate EMBEDDING_MODELS registry and are surfaced
 *  by list_models/get_model, never ranked. A custom effective definition list
 *  passed in is still filtered to chat definitions. */
export function rankableModels(
  registry: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): RankedModel[] {
  const out: RankedModel[] = [];
  for (const m of registry) {
    if ('kind' in m && m.kind === 'embedding') continue;
    if (m.public === false) continue;
    const pricing = getModelPricing(m.provider, m.canonical_name)
      ?? (m.api_model_id === m.canonical_name ? null : getModelPricing(m.provider, m.api_model_id));
    if (!pricing) continue;
    const candidateCapability = 'capability_indices' in m ? m.capability_indices : undefined;
    const intelligenceTier = 'intelligence_tier' in m ? m.intelligence_tier : undefined;
    out.push({
      id: m.canonical_name,
      provider: m.provider,
      context_length: m.context_window,
      intelligence_tier: intelligenceTier ?? null,
      auto_route: m.auto_route !== false,
      input_per_million: pricing.input_per_million,
      output_per_million: pricing.output_per_million,
      ...(candidateCapability && isValidCapabilityIndices(candidateCapability)
        ? { capability_indices: { ...candidateCapability } } // copy: consumers must not mutate the effective catalog
        : {}),
    });
  }
  return out;
}


function byId(a: RankedModel, b: RankedModel): number {
  // code-unit comparison: environment-independent total order (localeCompare
  // depends on ICU data, which would break the deterministic-order contract)
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Exported for the tiebreak contract test; ordering must be a total order. */
export function rankCompare(a: RankedModel, b: RankedModel, criterion: RankCriterion): number {
  switch (criterion) {
    case 'intelligence': {
      // Mirrors the auto-router's bonus-only semantics: a sourced index >= 50
      // is verified strength and ranks by value (desc); below 50 is NO bonus,
      // exactly like unmeasured — so a verified-weak model can never outrank
      // an unmeasured flagship. Within the second bucket the registry's
      // intelligence_tier ordinal decides (today's documented behavior).
      const aBonus = typeof a.capability_indices?.intelligence === 'number' && a.capability_indices.intelligence >= 50;
      const bBonus = typeof b.capability_indices?.intelligence === 'number' && b.capability_indices.intelligence >= 50;
      if (aBonus !== bBonus) return aBonus ? -1 : 1;
      if (aBonus && bBonus) {
        return b.capability_indices!.intelligence! - a.capability_indices!.intelligence!
          || a.input_per_million - b.input_per_million
          || byId(a, b);
      }
      const aTier = a.intelligence_tier ?? Number.NEGATIVE_INFINITY;
      const bTier = b.intelligence_tier ?? Number.NEGATIVE_INFINITY;
      return bTier - aTier
        || a.input_per_million - b.input_per_million
        || byId(a, b);
    }
    case 'price':
      return a.input_per_million - b.input_per_million
        || b.context_length - a.context_length
        || byId(a, b);
    case 'context':
      return b.context_length - a.context_length
        || a.input_per_million - b.input_per_million
        || byId(a, b);
  }
}

export function rankModels(
  criterion: RankCriterion,
  limit: number,
  registry: readonly EffectiveCatalogDefinition[] = EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
): RankedModel[] {
  return rankableModels(registry).sort((a, b) => rankCompare(a, b, criterion)).slice(0, limit);
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

function parseArgs(schema: Tool['inputSchema'], args: Record<string, unknown>): Record<string, unknown> {
  // Reject non-object input and unknown keys up front; then validate
  // required-ness and primitive types generically against the declared
  // schema so a future tool cannot silently coerce malformed arguments.
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'arguments must be an object');
  }
  const properties = schema.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      throw new McpError(ErrorCode.InvalidParams, `unknown argument: ${key}`);
    }
  }
  for (const required of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(args, required)) {
      throw new McpError(ErrorCode.InvalidParams, `missing required argument: ${required}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue; // explicit undefined == absent for optionals
    const declared = properties[key];
    if (!declared || typeof declared !== 'object' || !('type' in declared)) continue;
    const expected = declared.type;
    const ok = expected === 'string' ? typeof value === 'string'
      : expected === 'integer' ? Number.isInteger(value)
      : expected === 'number' ? typeof value === 'number'
      : expected === 'boolean' ? typeof value === 'boolean'
      : null;
    if (ok === null) {
      // fail closed: an unrecognized declared type must not silently skip
      // validation (that would undercut the no-silent-coercion promise)
      throw new McpError(ErrorCode.InvalidParams, `argument ${key} declares unsupported type: ${String(expected)}`);
    }
    if (!ok) {
      throw new McpError(ErrorCode.InvalidParams, `argument ${key} must be ${expected === 'integer' ? 'an integer' : `a ${expected}`}`);
    }
    // Declared enum/range constraints are schema-level too (a future tool
    // must not rely on its handler to catch what the schema already says).
    if ('enum' in declared && Array.isArray(declared.enum) && !declared.enum.includes(value)) {
      throw new McpError(ErrorCode.InvalidParams, `argument ${key} must be one of: ${declared.enum.join(', ')}`);
    }
    if (typeof value === 'number') {
      if ('minimum' in declared && typeof declared.minimum === 'number' && value < declared.minimum) {
        throw new McpError(ErrorCode.InvalidParams, `argument ${key} must be >= ${declared.minimum}`);
      }
      if ('maximum' in declared && typeof declared.maximum === 'number' && value > declared.maximum) {
        throw new McpError(ErrorCode.InvalidParams, `argument ${key} must be <= ${declared.maximum}`);
      }
    }
  }
  return args;
}

export function callTool(name: string, rawArgs: Record<string, unknown>): CallToolResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    // The tools/call METHOD exists; an unknown tool NAME is invalid input,
    // not a missing RPC method (spec: InvalidParams, not MethodNotFound).
    throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
  }
  const args = parseArgs(tool.inputSchema, rawArgs);

  switch (name) {
    case 'list_models': {
      return { content: [{ type: 'text', text: JSON.stringify(buildModelsList(null), null, 2) }] };
    }
    case 'get_model': {
      const modelId = args.model_id;
      if (typeof modelId !== 'string' || modelId.length === 0) {
        return errorResult('model_id must be a non-empty string');
      }
      const model = buildModelDetail(modelId, null);
      if (!model) {
        return errorResult(`model_not_found: ${modelId}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(model, null, 2) }] };
    }
    case 'rank_models': {
      // parseArgs already enforced the declared enum/range; these narrowing
      // defaults are unreachable fallbacks that keep the types honest.
      const criterion = typeof args.criterion === 'string' && isRankCriterion(args.criterion)
        ? args.criterion
        : 'intelligence';
      const limit = typeof args.limit === 'number' ? args.limit : 25;
      const ranked = rankModels(criterion, limit);
      return {
        content: [{ type: 'text', text: JSON.stringify(ranked, null, 2) }],
      };
    }
    default:
      // Unreachable today (the TOOLS.find guard above rejects unknown names),
      // but kept fail-loud so a future TOOLS entry without a handler cannot
      // silently return undefined to the client.
      throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
  }
}
