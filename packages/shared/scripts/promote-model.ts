#!/usr/bin/env tsx
/**
 * One-command promotion of a parked catalog entry to public (and, optionally,
 * auto-routed). Replaces the manual lockstep edit for models of EXISTING
 * providers.
 *
 *   pnpm --filter @routeshift/shared exec tsx scripts/promote-model.ts <canonical_name> [--auto-route] [--dry-run]
 *
 * The edit is textual and minimal: the entry keeps its line position and all
 * other fields; `public: false` is removed (making it default-public) and,
 * only with --auto-route, `auto_route: false` is removed too.
 *
 * Pricing gate: after computing the edit, pricing is resolved via
 * getModelPricing() semantics (curated PRICING_TABLE, then the generated
 * LiteLLM fallback). If NEITHER layer prices the model, the promotion is
 * REFUSED (non-zero exit, nothing written) and the exact PRICING_TABLE row to
 * paste is printed — an unpriced model would be silently dropped from
 * /v1/models and billed $0, so unpriced promotion must be a deliberate
 * second step, never silent.
 *
 * Refusals (non-zero exit, clear message):
 *   - no MODEL_REGISTRY entry matches canonical_name or api_model_id
 *   - the entry is already public (no `public: false` flag)
 *   - the entry's provider is not in PROVIDERS (new providers are onboarded
 *     by hand, not by this tool)
 */

import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, PROVIDERS_WITHOUT_RUNTIME_ADAPTER } from '../src/models.js';
import { getModelPricing, SUBSCRIPTION_PRICED_PROVIDERS, type ModelPricing } from '../src/cost-tables.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MODELS_PATH = join(SCRIPT_DIR, '..', 'src', 'models.ts');

export interface RegistryEntryLine {
  line: string;
  lineIndex: number;
  provider: string;
  canonicalName: string;
  apiModelId: string;
  /** true when the entry still carries `public: false`. */
  parked: boolean;
  /** true when the entry still carries `auto_route: false`. */
  autoRouteDisabled: boolean;
}

export interface PromotionOptions {
  autoRoute?: boolean;
}

export type PricingLookup = (provider: string, model: string) => ModelPricing | null;

export type PromotionResult =
  | {
      ok: true;
      source: string;
      entryLine: string;
      entry: RegistryEntryLine;
      priced: boolean;
      pricingTemplate: string | null;
    }
  | {
      ok: false;
      reason: 'not-found' | 'already-public' | 'unknown-provider' | 'ambiguous' | 'unsupported-format';
      message: string;
    };

function fieldValue(line: string, field: string): string | null {
  // Boundary-anchored: `default_provider:` must never satisfy a `provider`
  // lookup; fields are only recognized at object-property positions.
  const match = line.match(new RegExp(`(?:^|[,{])\\s*${field}:\\s*'([^']*)'`));
  return match ? match[1] : null;
}

/**
 * Locates ALL MODEL_REGISTRY entry lines whose canonical_name or api_model_id
 * matches `name` (exact, case-insensitive). Ids collide across providers
 * (azure/bedrock entries share api_model_ids with first-party entries), so a
 * promotion tool must never silently take the first hit.
 */
export function findEntryLines(source: string, name: string): RegistryEntryLine[] {
  const needle = name.toLowerCase();
  const matches: RegistryEntryLine[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('{ provider:')) continue;
    const provider = fieldValue(line, 'provider');
    const canonicalName = fieldValue(line, 'canonical_name');
    const apiModelId = fieldValue(line, 'api_model_id');
    if (!provider || !canonicalName || !apiModelId) continue;
    if (canonicalName.toLowerCase() !== needle && apiModelId.toLowerCase() !== needle) continue;
    matches.push({
      line,
      lineIndex: i,
      provider,
      canonicalName,
      apiModelId,
      parked: /\bpublic:\s*false\b/.test(line),
      autoRouteDisabled: /\bauto_route:\s*false\b/.test(line),
    });
  }
  return matches;
}

/** Removes a `<field>: false` pair plus exactly one adjacent comma/space run. */
function removeFalseFlag(line: string, field: string): string {
  // Mid-object: " <field>: false," followed by another field. Anchor on the
  // opening delimiter so a leading `{ public: false, …` keeps its `{ ` shape
  // (the file's one-line convention) instead of gluing the next field to `{`.
  const mid = line.replace(
    new RegExp(`([,{])\\s+${field}:\\s*false,\\s*`),
    '$1 ',
  );
  if (mid !== line) return mid;
  // Trailing: ", <field>: false" just before the closing brace.
  return line.replace(new RegExp(`\\s*,\\s+${field}:\\s*false`), '');
}

/**
 * Returns the promoted form of an entry line: `public: false` always removed;
 * `auto_route: false` removed only when opts.autoRoute is set. Field order,
 * position, and every other field are preserved.
 *
 * Hard-invariant guard: absence of `auto_route: false` means the auto-router
 * WILL route the model. Promoting (making public) without --auto-route must
 * therefore never leave the flag absent — if the entry didn't carry it, the
 * parked routing posture is preserved by appending it explicitly.
 */
export function buildPromotion(line: string, opts: PromotionOptions & { autoRouteWasDisabled?: boolean }): string {
  let promoted = removeFalseFlag(line, 'public');
  if (opts.autoRoute) {
    promoted = removeFalseFlag(promoted, 'auto_route');
  } else if (opts.autoRouteWasDisabled === false && !/\bauto_route:\s*false\b/.test(promoted)) {
    // Whitespace before the closing brace is optional — a hand-edited entry
    // ending `..._000},` must not silently skip the append (review round 2).
    promoted = promoted.replace(/\s*\},\s*$/, ', auto_route: false },');
  }
  return promoted;
}

/** The exact PRICING_TABLE row to paste for an unpriced model. */
export function pricingRowTemplate(provider: string, model: string): string {
  const cacheWriteNote =
    provider === 'anthropic'
      ? 'Anthropic bills prompt-cache writes (~1.25x input); omit cache_write_per_million so the fallback applies.'
      : `Non-Anthropic providers use a cache-hit/cache-miss model with NO separate cache-write charge — set cache_write_per_million: 0 explicitly (per cost-tables.ts comments) so the Anthropic-style 1.25x-input fallback does not overcharge.`;
  return [
    `Add a curated row to PRICING_TABLE in packages/shared/src/cost-tables.ts:`,
    ``,
    `  { provider: '${provider}', model: '${model}', input_per_million: <INPUT_USD_PER_MTOK>, output_per_million: <OUTPUT_USD_PER_MTOK>${provider === 'anthropic' ? '' : ', cache_write_per_million: 0'} },`,
    ``,
    `Note: ${cacheWriteNote}`,
  ].join('\n');
}

/**
 * Pure promotion pipeline: validates, computes the edited source, and resolves
 * pricing (injectable for tests). Never touches the filesystem.
 *
 * When the model is unpriced in BOTH the curated PRICING_TABLE and the
 * generated LiteLLM fallback, the result is still ok:true with priced:false
 * and a paste-template — the CLI layer refuses to write and exits non-zero.
 */
export function applyPromotion(
  source: string,
  name: string,
  opts: PromotionOptions & { pricingLookup?: PricingLookup } = {},
): PromotionResult {
  const matches = findEntryLines(source, name);
  if (matches.length === 0) {
    // The entry may exist but be invisible to the one-line convention
    // (prettier-wrapped multi-line entries carry fields across lines). That
    // case must be a LOUD format refusal, not a misleading "not found".
    // Comment lines are stripped first: a doc/header mentioning the id is
    // not evidence of a multi-line entry (review round 2).
    const codeOnly = source
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const quotedElsewhere = new RegExp(
      `(?:canonical_name|api_model_id):\\s*'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
      'i',
    ).test(codeOnly);
    if (quotedElsewhere) {
      return {
        ok: false,
        reason: 'unsupported-format',
        message:
          `'${name}' appears in models.ts but not in the one-line entry convention ` +
          `(likely reformatted multi-line). Promote by hand.`,
      };
    }
    return {
      ok: false,
      reason: 'not-found',
      message: `No MODEL_REGISTRY entry matches '${name}' (checked canonical_name and api_model_id, case-insensitive).`,
    };
  }
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.provider}/${m.canonicalName}`).join(', ');
    return {
      ok: false,
      reason: 'ambiguous',
      message:
        `'${name}' matches ${matches.length} entries (${candidates}). Promoting the wrong one flips ` +
        `routing on another provider's model — disambiguate by editing models.ts by hand.`,
    };
  }
  const entry = matches[0];
  if (!/\},\s*$/.test(entry.line)) {
    return {
      ok: false,
      reason: 'unsupported-format',
      message:
        `Entry '${entry.canonicalName}' does not open and close on one line (multi-line or ` +
        `reformatted entry). This tool only edits the file's one-line convention — promote by hand.`,
    };
  }
  if (!PROVIDERS.includes(entry.provider as (typeof PROVIDERS)[number])) {
    return {
      ok: false,
      reason: 'unknown-provider',
      message:
        `Entry '${entry.canonicalName}' has provider '${entry.provider}', which is not in PROVIDERS. ` +
        `New providers are onboarded by hand (adapter, endpoints, pricing) — this tool only promotes models of existing providers.`,
    };
  }
  if (
    (PROVIDERS_WITHOUT_RUNTIME_ADAPTER as readonly string[]).includes(entry.provider)
  ) {
    return {
      ok: false,
      reason: 'unknown-provider',
      message:
        `Entry '${entry.canonicalName}' has provider '${entry.provider}', which is in the catalog but has NO registered ` +
        `runtime adapter — promotion would mint a publicly-listed model that 400s "Unknown provider" on every request. ` +
        `Onboard the adapter first (routeshift-provider-onboarding), then remove the provider from ` +
        `PROVIDERS_WITHOUT_RUNTIME_ADAPTER and promote.`,
    };
  }
  if (!entry.parked) {
    return {
      ok: false,
      reason: 'already-public',
      message: `Entry '${entry.canonicalName}' is already public (no public: false flag) — nothing to promote.`,
    };
  }
  // A parked entry carrying explicit `auto_route: true` is contradictory.
  // Promotion without --auto-route would have to FLIP it (not append), and
  // appending would emit a duplicate `auto_route` key (invalid TS). Neither
  // is this tool's call — refuse loudly (review round 2).
  if (/\bauto_route:\s*true\b/.test(entry.line)) {
    return {
      ok: false,
      reason: 'unsupported-format',
      message:
        `Entry '${entry.canonicalName}' is parked yet carries auto_route: true — a contradictory ` +
        `routing posture this tool won't guess at. Set the intended posture by hand.`,
    };
  }

  const entryLine = buildPromotion(entry.line, { ...opts, autoRouteWasDisabled: entry.autoRouteDisabled });
  // Never report success while a flag survived: formatting drift the removal
  // regexes don't recognize must be a loud refusal, not a silent no-op.
  if (/\bpublic:\s*false\b/.test(entryLine) || (opts.autoRoute && /\bauto_route:\s*false\b/.test(entryLine))) {
    return {
      ok: false,
      reason: 'unsupported-format',
      message: `Entry '${entry.canonicalName}' has an unrecognized flag format — promote by hand.`,
    };
  }
  // Symmetric guard: promotion without --auto-route must leave the entry
  // positively NON-auto-routable. Verify the flag is PRESENT, not just that
  // removals happened — a missed append is the one outcome that silently
  // routes customer traffic (review round 2).
  if (!opts.autoRoute && !/\bauto_route:\s*false\b/.test(entryLine)) {
    return {
      ok: false,
      reason: 'unsupported-format',
      message:
        `Entry '${entry.canonicalName}' could not be confirmed non-auto-routable after promotion ` +
        `(auto_route: false append failed) — promote by hand.`,
    };
  }
  const lines = source.split('\n');
  lines[entry.lineIndex] = entryLine;

  const lookup: PricingLookup = opts.pricingLookup ?? getModelPricing;
  // Providers with a documented subscription convention whose curated rows are
  // DELIBERATELY zero-rated (cost-tables.ts: xiaomi Token Plan — per-request
  // cost is reported as 0 by design; subscription cost lives outside the
  // table). Zero rates anywhere else are not pricing — promoting on them
  // bills $0 for every request.
  const positivelyPriced = (model: string): boolean => {
    const p = lookup(entry.provider, model);
    if (p === null) return false;
    return (
      p.input_per_million > 0 ||
      p.output_per_million > 0 ||
      (SUBSCRIPTION_PRICED_PROVIDERS as readonly string[]).includes(entry.provider)
    );
  };
  const priced =
    positivelyPriced(entry.canonicalName) ||
    (entry.apiModelId !== entry.canonicalName && positivelyPriced(entry.apiModelId));

  return {
    ok: true,
    source: lines.join('\n'),
    entryLine,
    entry,
    priced,
    pricingTemplate: priced ? null : pricingRowTemplate(entry.provider, entry.canonicalName),
  };
}

export interface CliDeps {
  readSource?: () => string;
  writeSource?: (content: string) => void;
  pricingLookup?: PricingLookup;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

const USAGE =
  'Usage: promote-model.ts <canonical_name> [--auto-route] [--dry-run]\n' +
  '  Promotes a parked MODEL_REGISTRY entry: removes public: false (and,\n' +
  '  with --auto-route, auto_route: false). Refuses to promote an entry that\n' +
  '  has no pricing in either PRICING_TABLE or the generated LiteLLM fallback.';

/**
 * CLI body, isolated from process.argv/process.exit so tests can drive it with
 * in-memory fixtures. Returns the process exit code.
 */
export function run(argv: string[], deps: CliDeps = {}): number {
  const log = deps.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const error = deps.error ?? ((m: string) => process.stderr.write(`${m}\n`));

  const positional = argv.filter((a) => !a.startsWith('--'));
  const autoRoute = argv.includes('--auto-route');
  const dryRun = argv.includes('--dry-run');

  if (positional.length !== 1) {
    error(USAGE);
    return 2;
  }
  const name = positional[0];

  const readSource = deps.readSource ?? (() => readFileSync(MODELS_PATH, 'utf8'));
  const writeSource =
    deps.writeSource ??
    ((content: string) => {
      // Crash-safe write: a truncated registry must never be what a crash leaves behind.
      const tmp = `${MODELS_PATH}.tmp-${process.pid}`;
      writeFileSync(tmp, content);
      renameSync(tmp, MODELS_PATH);
    });

  const result = applyPromotion(readSource(), name, {
    autoRoute,
    pricingLookup: deps.pricingLookup,
  });

  if (!result.ok) {
    error(`promote-model: refusing to promote '${name}': ${result.message}`);
    return 1;
  }

  if (!result.priced) {
    error('');
    error(`⚠️  UNPRICED MODEL — promotion refused.`);
    error(
      `'${result.entry.canonicalName}' (${result.entry.provider}) has NO pricing in the curated PRICING_TABLE ` +
        `and NO pricing in the generated LiteLLM fallback.`,
    );
    error(
      `Promoting it would silently drop it from /v1/models and bill $0 for every request. ` +
        `Add curated pricing first, then re-run this command.`,
    );
    error('');
    error(result.pricingTemplate ?? '');
    error('');
    return 1;
  }

  if (dryRun) {
    log(`[dry-run] ${name} → ${result.entryLine.trim()}`);
    log(`[dry-run] priced via PRICING_TABLE or generated LiteLLM fallback; no file written.`);
    return 0;
  }

  writeSource(result.source);
  log(
    `promoted ${result.entry.canonicalName} (${result.entry.provider}): public` +
      `${autoRoute ? ', auto_route' : ''} — was: ${result.entry.line.trim()}`,
  );
  log(`now: ${result.entryLine.trim()}`);
  return 0;
}

// Only run when invoked directly (not when imported by the unit test).
// endsWith is suffix-collidable ('unpromote-model.ts' ends with 'promote-model.ts') — compare
// resolved paths so importing a same-suffix module never executes the CLI
// (nw-kimi, review round 4).
const invokedDirectly = (() => {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(argvPath);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  process.exitCode = run(process.argv.slice(2));
}
