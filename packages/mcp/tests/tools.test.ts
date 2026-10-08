import { describe, expect, it } from 'vitest';
import { callTool, rankCompare, rankModels, rankableModels, TOOLS } from '../src/tools.js';
import {
  buildModelDetail,
  buildModelsList,
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  getModelPricing,
  type EffectiveCatalogDefinition,
  type GeneratedCatalogModel,
} from '@routeshift/shared';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

interface CallResultLike {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function textOf(result: CallResultLike): string {
  const text = result.content.find((c) => c.type === 'text');
  if (!text?.text) throw new Error('no text content');
  return text.text;
}

function errorTextOf(result: CallResultLike): string {
  const parsed = JSON.parse(textOf(result)) as { error: string };
  return parsed.error;
}

describe('list_models', () => {
  it('returns the public catalog with embeddings, mirroring /v1/models', () => {
    const result = callTool('list_models', {});
    expect(result.isError).toBeUndefined();
    const list = JSON.parse(textOf(result));
    expect(list.object).toBe('list');
    expect(Array.isArray(list.data)).toBe(true);

    const ids = list.data.map((m: { id: string }) => m.id);
    // parked / public:false entries are excluded from the public catalog
    expect(ids).not.toContain('grok-4.20-reasoning');
    expect(ids).not.toContain('deepseek-v3.1');
    // public entries are present, including embeddings
    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('text-embedding-3-small');

    const gpt = list.data.find((m: { id: string }) => m.id === 'gpt-5.5');
    expect(gpt.endpoints.map((e: { provider: string }) => e.provider)).toEqual(['openai', 'azure']);
    expect(gpt.endpoints[1].data_policy).toEqual({ zdr: true });
  });
  it('preserves generated explicit-only metadata in the shared MCP catalog projection', () => {
    const generated: GeneratedCatalogModel = {
      provider: 'openai',
      canonical_name: 'gpt-4o-mini',
      api_model_id: 'gpt-4o-mini',
      context_window: 128_000,
      source: 'generated',
      public: true,
      explicit_only: true,
      auto_route: false,
      source_url: 'https://example.test/litellm.json',
      source_hash: 'fixture-hash',
      source_as_of: '2026-08-26T12:00:00.000Z',
    };
    const injected = buildModelsList(null, [], {}, [generated]).data[0];
    const publicResult = JSON.parse(textOf(callTool('list_models', {})));

    expect(injected).toMatchObject({
      id: 'gpt-4o-mini',
      catalog: {
        source: 'generated',
        routing: 'explicit_only',
        source_as_of: generated.source_as_of,
      },
    });
    expect(publicResult).toEqual(buildModelsList(null));
    expect(publicResult.data.every((model: { catalog?: unknown }) => model.catalog)).toBe(true);
  });
});


describe('get_model', () => {
  it('resolves a canonical id', () => {
    const result = callTool('get_model', { model_id: 'gpt-5.4' });
    const model = JSON.parse(textOf(result));
    expect(model.id).toBe('gpt-5.4');
    expect(model.object).toBe('model');
  });

  it('resolves a provider api_model_id to the canonical entry', () => {
    const result = callTool('get_model', { model_id: 'claude-opus-4-6-20250219' });
    const model = JSON.parse(textOf(result));
    expect(model.id).toBe('claude-opus-4-6');
  });

  it('returns a tool-level isError result for an unknown id', () => {
    const result = callTool('get_model', { model_id: 'does-not-exist' });
    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toContain('model_not_found');
  });

  it('refuses parked (public: false) models like the unauthenticated catalog', () => {
    const result = callTool('get_model', { model_id: 'grok-4.20-reasoning' });
    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toContain('model_not_found');
  });

  it('omits public-but-unpriced models like the catalog projection', () => {
    // buildModelDetail's pricing gate mirrors list_models: a public model
    // with no priced canonical row is a catalog gap and must not surface.
    const unpriced = buildModelDetail('no-price-model', null, [
      { provider: 'openai', canonical_name: 'no-price-model', api_model_id: 'no-price-model', context_window: 1000 },
    ]);
    expect(unpriced).toBeNull();
  });

  it('treats an empty model_id as a semantic failure (isError)', () => {
    const result = callTool('get_model', { model_id: '' });
    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toContain('model_id');
  });
});

describe('rank_models', () => {
  it('is deterministic and limited', () => {
    const a = rankModels('intelligence', 25);
    const b = rankModels('intelligence', 25);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(25);
    // top entry is a tier-3 model
    expect(a[0].intelligence_tier).toBe(3);
  });

  it('ranks priced generated explicit-only chat models without promoting them', () => {
    const generated: GeneratedCatalogModel = {
      provider: 'openai',
      canonical_name: 'gpt-4o-mini',
      api_model_id: 'gpt-4o-mini',
      context_window: 128_000,
      source: 'generated',
      public: true,
      explicit_only: true,
      auto_route: false,
      source_url: 'https://example.test/litellm.json',
      source_hash: 'fixture-hash',
      source_as_of: '2026-08-26T12:00:00.000Z',
    };
    const mutableEffective = EFFECTIVE_DISPATCHABLE_CHAT_MODELS as EffectiveCatalogDefinition[];
    const originalLength = mutableEffective.length;
    mutableEffective.push(generated);
    try {
      const ranked = rankableModels();
      const model = ranked.find((entry) => entry.id === generated.canonical_name);

      expect(model).toMatchObject({
        id: 'gpt-4o-mini',
        intelligence_tier: null,
        auto_route: false,
      });
      expect(ranked.some((entry) => entry.id === 'text-embedding-3-small')).toBe(false);
    } finally {
      mutableEffective.splice(originalLength);
    }
  });

  it('orders exact ties by id regardless of input order', () => {
    // All fields equal except id: the code-unit tiebreak must produce one
    // stable total order (localeCompare depends on ICU data; byId does not).
    const base = {
      provider: 'openai',
      context_length: 100_000,
      intelligence_tier: 2,
      auto_route: true,
      input_per_million: 1,
      output_per_million: 2,
    };
    const zeta = { ...base, id: 'zeta' };
    const alpha = { ...base, id: 'alpha' };
    expect(rankCompare(zeta, alpha, 'intelligence')).toBeGreaterThan(0);
    expect(rankCompare(alpha, zeta, 'intelligence')).toBeLessThan(0);
    expect(rankCompare(zeta, zeta, 'intelligence')).toBe(0);
  });

  it('intelligence: sourced indices >= 50 rank by value; weak/unmeasured by tier', () => {
    const makeIndexed = (id: string, intelligence: number, tier = 3) => ({
      provider: 'openai', id, context_length: 100_000, intelligence_tier: tier,
      auto_route: true, input_per_million: 1, output_per_million: 2,
      capability_indices: { intelligence, source: 's', source_as_of: '2026-08-10' },
    });
    const unindexedTier3 = {
      provider: 'openai', id: 'unmeasured', context_length: 100_000, intelligence_tier: 3,
      auto_route: true, input_per_million: 1, output_per_million: 2,
    };
    // verified strength (>= 50) ranks by value, above everything else
    expect(rankCompare(makeIndexed('measured-high', 92), makeIndexed('measured', 45), 'intelligence')).toBeLessThan(0);
    expect(rankCompare(makeIndexed('measured', 92), unindexedTier3, 'intelligence')).toBeLessThan(0);
    // verified-WEAK (below 50) is NO bonus, exactly like unmeasured: a weak
    // tier-2 model sorts below an unmeasured tier-3 flagship (tier decides)
    const weakTier2 = makeIndexed('weak', 10, 2);
    expect(rankCompare(weakTier2, unindexedTier3, 'intelligence')).toBeGreaterThan(0);
    // within the non-bonus bucket the tier ordinal is the fallback
    expect(rankCompare(unindexedTier3, { ...unindexedTier3, id: 'tier2', intelligence_tier: 2 }, 'intelligence')).toBeLessThan(0);
  });

  it('intelligence sorts tier desc then input price asc', () => {
    const ranked = rankModels('intelligence', 100);
    for (let i = 1; i < ranked.length; i++) {
      const prev = ranked[i - 1];
      const cur = ranked[i];
      const prevTier = prev.intelligence_tier ?? 0;
      const curTier = cur.intelligence_tier ?? 0;
      if (prevTier !== curTier) {
        expect(prevTier).toBeGreaterThan(curTier);
      } else {
        expect(prev.input_per_million).toBeLessThanOrEqual(cur.input_per_million);
      }
    }
  });

  it('price sorts by input price asc', () => {
    const ranked = rankModels('price', 100);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].input_per_million).toBeLessThanOrEqual(ranked[i].input_per_million);
    }
  });

  it('context sorts by context window desc', () => {
    const ranked = rankModels('context', 100);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].context_length).toBeGreaterThanOrEqual(ranked[i].context_length);
    }
  });

  it('excludes parked models and mirrors the public catalog pricing gate', () => {
    const ranked = rankableModels();
    const rankedById = new Map(ranked.map((m) => [m.id, m]));
    expect(rankedById.has('grok-4.20-reasoning')).toBe(false); // public: false
    expect(rankedById.has('deepseek-v3.1')).toBe(false); // public: false

    // parity: every public CHAT model in /v1/models (which the catalog builder
    // includes only when priced) must be rankable — the two surfaces share one
    // pricing gate. Embeddings are catalog-visible but never ranked.
    const publicCatalog = buildModelsList(null).data
      .filter((m) => m.architecture?.modality !== 'text->embedding');
    expect(rankedById.size).toBe(publicCatalog.length);
    for (const m of publicCatalog) {
      const r = rankedById.get(m.id);
      expect(r, `rankable entry for ${m.id}`).toBeDefined();
      // ranked FACTS match the public projection, not just ids: context
      // window and canonical-provider pricing derive from the same sources
      expect(r!.context_length).toBe(m.context_length);
      const pricing = getModelPricing(m.owned_by, m.id);
      expect(pricing).not.toBeNull();
      expect(r!.input_per_million).toBe(pricing!.input_per_million);
      expect(r!.output_per_million).toBe(pricing!.output_per_million);
    }
  });

  it('keeps limited rank_models on the same effective chat-model domain', () => {
    const list = JSON.parse(textOf(callTool('list_models', {}))) as {
      data: Array<{ id: string; architecture?: { modality?: string } }>;
    };
    const ranked = JSON.parse(textOf(callTool('rank_models', { limit: 100 }))) as Array<{ id: string }>;
    const chatIds = list.data
      .filter((model) => model.architecture?.modality !== 'text->embedding')
      .map((model) => model.id);

    expect(ranked).toHaveLength(Math.min(100, chatIds.length));
    expect(new Set(ranked.map((model) => model.id)).size).toBe(ranked.length);
    expect(ranked.every((model) => chatIds.includes(model.id))).toBe(true);
    expect(ranked.map((model) => model.id)).not.toContain('text-embedding-3-small');
  });

  it('respects limit bounds and criterion via schema-level errors', () => {
    const result = callTool('rank_models', { limit: 3 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toHaveLength(3);
    // range and enum are declared in the inputSchema, so violations are
    // schema-level InvalidParams, not tool-level errors
    expect(() => callTool('rank_models', { limit: 0 })).toThrowError(/>= 1/);
    expect(() => callTool('rank_models', { limit: 101 })).toThrowError(/<= 100/);
    expect(() => callTool('rank_models', { criterion: 'quality' })).toThrowError(/must be one of/);
  });
});

describe('argument validation', () => {
  // Convention: schema-level misuse (unknown key, non-object, missing
  // required, wrong primitive type, declared enum/range violation) is a
  // protocol InvalidParams error — a client bug. Semantic failures (an
  // unknown model id — a recoverable business outcome) are tool-level
  // isError results the agent can recover from. Both fail loudly; neither
  // is silent.
  it('rejects unknown arguments with a protocol error', () => {
    expect(() => callTool('list_models', { nope: true })).toThrowError(/unknown argument/);
  });

  it('rejects non-object arguments with a protocol error', () => {
    expect(() => callTool('list_models', 'nope' as unknown as Record<string, unknown>)).toThrowError(/arguments/);
  });

  it('rejects missing required arguments generically from the schema', () => {
    expect(() => callTool('get_model', {})).toThrowError(/missing required argument: model_id/);
  });

  it('rejects wrong primitive types against the schema', () => {
    expect(() => callTool('rank_models', { limit: 'three' })).toThrowError(/must be an integer/);
    expect(() => callTool('get_model', { model_id: 42 })).toThrowError(/must be a string/);
  });

  it('treats explicit undefined on an optional argument as absent', () => {
    const result = callTool('rank_models', { criterion: undefined, limit: 3 });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toHaveLength(3);
  });

  it('rejects floats for integer arguments at the schema level', () => {
    expect(() => callTool('rank_models', { limit: 12.34 })).toThrowError(/must be an integer/);
  });

  it('rejects unknown tools with InvalidParams (the method exists; the name is invalid)', () => {
    expect(() => callTool('frobnicate', {})).toThrowError(McpError);
    try {
      callTool('frobnicate', {});
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
    }
  });
});

describe('tool registry', () => {
  it('exposes exactly the three read-only tools', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['list_models', 'get_model', 'rank_models']);
    for (const tool of TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});
