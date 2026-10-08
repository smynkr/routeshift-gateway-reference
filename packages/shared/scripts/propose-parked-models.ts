#!/usr/bin/env tsx
/**
 * Propose newly-released models as PARKED registry entries (catalog autopilot).
 *
 *   pnpm --filter @routeshift/shared propose-parked            # dry-run (default)
 *   pnpm --filter @routeshift/shared propose-parked -- --apply # write models.ts
 *   pnpm --filter @routeshift/shared propose-parked -- --json  # machine JSON
 *
 * Pipeline: fetch the community LiteLLM catalog → computeDrift() surfaces new
 * models in families RouteShift already routes (HIGH-signal only, never the
 * long tail) → candidate filters (modality denylist, sane context window,
 * chat-only) → parked ModelDefinition entries appended to MODEL_REGISTRY.
 *
 * SAFETY: every proposed entry is parked — `auto_route: false, public: false`.
 * resolveProvider() returns '' for `public === false` (undispatchable, so
 * unbillable) and the auto-router skips `auto_route === false`; the public
 * /v1/models catalog filters `public === false` out. One documented
 * exception: a key admin-allowlisted to an explicit parked id can SEE that id
 * in its scoped /v1/models listing (it still can't dispatch it). A proposed
 * entry can never receive customer traffic until a human promotes it
 * (scripts/promote-model.ts). Pricing falls back to the generated LiteLLM
 * table via getModelPricing(); PRICING_TABLE is hand-curated and never
 * touched here.
 *
 * Runs at cron time only, never at request time.
 */

import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeDrift,
  type DiscoveredModel,
} from './detect-model-drift.js';
import { fetchLiteLLMCatalog, type LiteLLMEntry } from './litellm-source.js';
import { MODEL_REGISTRY, PROVIDERS } from '../src/models.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MODELS_PATH = join(SCRIPT_DIR, '..', 'src', 'models.ts');

/** Crash-safe write: a truncated registry must never be what a crash leaves behind. */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const SECTION_HEADER_PREFIX = '// ── Auto-proposed parked candidates (detect-models ';

/**
 * Modality denylist: audio/speech/image/video/moderation models are not chat
 * models RouteShift routes — never propose them even if the id shares a family
 * prefix with a tracked chat model.
 */
const MODALITY_DENYLIST =
  /audio|tts|text-to-speech|realtime|transcrib|whisper|dall-e|image|video|moderation/i;

/**
 * Supply-chain gate: LiteLLM catalog ids are third-party, network-fetched data
 * that buildEntries interpolates into TypeScript string literals VERBATIM. A
 * crafted id containing a quote/brace/comma could break out of the literal and
 * inject a default-public, default-auto-routed registry entry. Only boring
 * charset ids are ever proposed; anything else is dropped loudly (stderr) so a
 * poisoned catalog row fails visible instead of shipping in the bot PR.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/**
 * Contract candidate filters, on top of computeDrift's guards:
 *  (a) modality denylist on the model id;
 *  (b) context_window (LiteLLM max_input_tokens) must be a positive INTEGER
 *      within a sane ceiling — 1e21/500000.5 pass Number.isFinite yet produce
 *      nonsense registry data (`1e+21` survives digit-grouping ungrouped);
 *  (c) callers pass only newInTrackedFamily — the long tail is never proposed.
 *  (d) SAFE_ID charset on BOTH provider and model id (injection guard above).
 * Chat-only: MODEL_REGISTRY is the chat catalog; embedding drift is surfaced by
 * detect-models for manual onboarding (dimensions must be verified by hand).
 */
export const MAX_CONTEXT_WINDOW = 32_000_000;

/**
 * True when the proxy's resolveProvider would dispatch this UNKNOWN id by
 * prefix (gpt- / o3- / o4- prefixes to openai, claude- prefix to anthropic,
 * gemini- prefix to google), so parking an exact match for it would revoke
 * working customer traffic.
 * MUST mirror apps/proxy/src/proxy-handler.ts resolveProvider — pinned by
 * tests/proxy-handler-basic.test.ts ("no parked entry shadows the prefix
 * passthrough"). Shared by propose-parked-models.ts and detect-model-drift.ts
 * so the report never proposes ids the autopilot would refuse.
 */
export function isPrefixPassthroughCovered(model: string): boolean {
  return (
    model.startsWith('gpt-') ||
    model === 'o3' ||
    model.startsWith('o3-') ||
    model === 'o4' ||
    model.startsWith('o4-') ||
    model.startsWith('claude-') ||
    model.startsWith('gemini-')
  );
}

export function filterCandidates(models: DiscoveredModel[]): DiscoveredModel[] {
  return models.filter((m) => {
    if (
      m.kind !== 'chat' ||
      MODALITY_DENYLIST.test(m.model) ||
      typeof m.context_window !== 'number' ||
      !Number.isInteger(m.context_window) ||
      m.context_window <= 0 ||
      m.context_window > MAX_CONTEXT_WINDOW
    ) {
      return false;
    }
    if (!SAFE_ID.test(m.model) || !SAFE_ID.test(m.provider)) {
      process.stderr.write(
        `propose-parked: dropping candidate with unsafe id charset: ${m.provider}/${m.model}\n`,
      );
      return false;
    }
    // Passthrough revocation guard (opus, review round 4): the proxy's
    // resolveProvider dispatches UNKNOWN ids by prefix (gpt-*/o3*/o4* →
    // openai, claude-* → anthropic, gemini-* → google), so brand-new flagship
    // models work the day they ship. Parking such an id installs an exact
    // registry match that returns '' — converting working customer requests
    // into 400s on merge. Leave passthrough-covered ids to the drift issue +
    // priced manual onboarding; the predicate MUST mirror
    // apps/proxy/src/proxy-handler.ts resolveProvider (pinned by the
    // proxy-side test: no parked registry entry may match it).
    if (isPrefixPassthroughCovered(m.model)) {
      process.stderr.write(
        `propose-parked: dropping candidate covered by the proxy prefix passthrough (parking would revoke working requests): ${m.provider}/${m.model}\n`,
      );
      return false;
    }
    // Belt-and-braces: computeDrift's family tracking implies a proxied
    // provider, but a bug there must never emit an entry for a provider the
    // proxy doesn't support (unpriced-model silent-drop trap).
    if (!(PROVIDERS as readonly string[]).includes(m.provider)) {
      process.stderr.write(
        `propose-parked: dropping candidate with unknown provider: ${m.provider}/${m.model}\n`,
      );
      return false;
    }
    return true;
  });
}

/** Exact one-line parked ModelDefinition entries, in input order. */
export function buildEntries(models: DiscoveredModel[]): string[] {
  return models.map(
    (m) =>
      `  { provider: '${m.provider}', canonical_name: '${m.model}', api_model_id: '${m.model}', ` +
      // Underscore-separated numeric literal per repo convention: 1000000 →
      // 1_000_000. Deterministic regex grouping — toLocaleString depends on the
      // runtime's ICU data and silently stops grouping under a no-ICU build.
      `context_window: ${String(m.context_window as number).replace(/\B(?=(\d{3})+(?!\d))/g, '_')}, auto_route: false, public: false },`,
  );
}

/**
 * Insert ONE dated auto-proposed section at the END of MODEL_REGISTRY, just
 * before the array's closing `];`. A prior auto-proposed section does not block
 * appending a new dated one — dedupe is guaranteed upstream by the registry
 * membership guard (computeDrift + notInRegistry both skip known ids).
 *
 * The closing bracket is located as the first line that is exactly `];` after
 * the MODEL_REGISTRY declaration — robust to entries containing `]` inside
 * strings/comments.
 */
export function applyProposals(
  modelsTsSource: string,
  entries: string[],
  dateYYYYMMDD: string,
): string {
  if (entries.length === 0) return modelsTsSource;

  // Anchor on the DECLARATION, not the first textual occurrence: models.ts
  // references MODEL_REGISTRY earlier (getModelContextWindow iterates it), and
  // a future comment/type alias mentioning the name must not re-anchor the
  // insertion into the wrong array.
  const declIdx = modelsTsSource.search(/^export const MODEL_REGISTRY\b/m);
  if (declIdx === -1) throw new Error('MODEL_REGISTRY declaration not found in models.ts source');
  // The one-line entry convention is load-bearing for this tool (same as
  // promote-model.ts): a hand-corrupted file whose string field embeds a real
  // newline before `];` would mis-anchor the insertion — but the resulting
  // models.ts then fails the workflow's pre-push build+test gate LOUDLY
  // (never reaches the PR), which is the backstop for this theoretical case.
  // Full-line anchor: '\n];' alone would also match a line beginning
  // '];' with trailing comment text (nw-kimi, review round 4).
  const closingIdx = modelsTsSource.indexOf('\n];\n', declIdx);
  if (closingIdx === -1) throw new Error('MODEL_REGISTRY closing bracket not found in models.ts source');

  const header = `${SECTION_HEADER_PREFIX}${dateYYYYMMDD}) — inert until promoted. ──`;
  const section = ['', header, ...entries].join('\n');
  return modelsTsSource.slice(0, closingIdx) + section + modelsTsSource.slice(closingIdx);
}

/** High-signal, filter-passing proposals for a LiteLLM catalog. */
export function computeProposals(catalog: Record<string, LiteLLMEntry>): DiscoveredModel[] {
  // Sorted by provider/model: LiteLLM's catalog key order is unstable, and an
  // unsorted map() would produce nondeterministic PR diffs across runs
  // (review round 2).
  return filterCandidates(computeDrift(catalog).newInTrackedFamily).sort((a, b) =>
    a.provider === b.provider
      ? a.model < b.model
        ? -1
        : a.model > b.model
          ? 1
          : 0
      : a.provider < b.provider
        ? -1
        : 1,
  );
}

/**
 * Belt-and-braces on top of computeDrift's known-id check: drop any candidate
 * whose canonical_name OR api_model_id (case-insensitive) is already in
 * MODEL_REGISTRY — e.g. the registry changed since the drift diff was computed.
 */
function notInRegistry(models: DiscoveredModel[]): DiscoveredModel[] {
  const known = new Set<string>();
  for (const m of MODEL_REGISTRY) {
    known.add(m.canonical_name.toLowerCase());
    known.add(m.api_model_id.toLowerCase());
  }
  return models.filter((m) => !known.has(m.model.toLowerCase()));
}

/**
 * Human-rejected proposals: models a reviewer decided NOT to onboard (e.g. by
 * closing a bot proposal PR unmerged). Without this list the bot re-proposes
 * the same rejected ids every week forever (review round 2). Add the rejected
 * id (lowercase, `provider/model` or bare model id) to
 * propose-parked-exclusions.json next to this script.
 */
export function loadExclusions(path: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    // File absent = nothing rejected yet. Anything else (permissions, a bad
    // path, EISDIR) must fail loudly: silently degrading to "no exclusions"
    // re-proposes every human-rejected candidate — the failure this file
    // exists to prevent.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((e) => typeof e !== 'string')) {
    throw new Error(`propose-parked exclusions at ${path} must be a JSON array of strings`);
  }
  return new Set(parsed.map((e) => e.toLowerCase()));
}

export function notExcluded(models: DiscoveredModel[], exclusions: Set<string>): DiscoveredModel[] {
  if (exclusions.size === 0) return models;
  return models.filter((m) => {
    const excluded = exclusions.has(m.model.toLowerCase()) || exclusions.has(`${m.provider}/${m.model}`.toLowerCase());
    if (excluded) {
      process.stderr.write(`propose-parked: skipping human-rejected candidate: ${m.provider}/${m.model}\n`);
    }
    return !excluded;
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const asJson = process.argv.includes('--json');

  const catalog = await fetchLiteLLMCatalog();
  const exclusions = loadExclusions(join(SCRIPT_DIR, 'propose-parked-exclusions.json'));
  const proposals = notExcluded(notInRegistry(computeProposals(catalog)), exclusions);
  const entries = buildEntries(proposals);

  if (apply && entries.length > 0) {
    const source = readFileSync(MODELS_PATH, 'utf8');
    const date = new Date().toISOString().slice(0, 10);
    writeFileAtomic(MODELS_PATH, applyProposals(source, entries, date));
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ applied: apply, proposed: proposals }, null, 2) + '\n');
    return;
  }
  if (!apply) {
    for (const line of entries) process.stdout.write(line + '\n');
  }
  process.stdout.write(`proposed=${proposals.length}\n`);
}

// Only run when invoked directly (not when imported by the unit test).
// endsWith is suffix-collidable ('unpropose-parked-models.ts' ends with 'propose-parked-models.ts') — compare
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
  main().catch((err) => {
    console.error('propose-parked-models failed:', err);
    process.exit(1);
  });
}
