#!/usr/bin/env tsx
/**
 * Detect model-catalog drift between the community LiteLLM catalog and
 * RouteShift's own MODEL_REGISTRY / EMBEDDING_MODELS.
 *
 *   pnpm --filter @routeshift/shared detect-models          # human report
 *   pnpm --filter @routeshift/shared detect-models --json    # machine JSON
 *
 * Purpose: RouteShift's routable model catalog (models.ts / embedding-models.ts)
 * is hand-maintained and goes stale when providers ship new models. The weekly
 * `sync-pricing` cron already refreshes PRICES from LiteLLM but never tells us a
 * *new model exists*. This tool closes that gap: it reports models LiteLLM knows
 * about (for providers RouteShift proxies) that are absent from our registry —
 * i.e. candidates to onboard — plus registry models LiteLLM no longer lists.
 *
 * SAFETY: this tool never edits the registry and never enables routing. New
 * models are proposed as PARKED ModelDefinition entries (`auto_route: false`,
 * `public: false`) for a human to review and promote via the
 * routeshift-provider-onboarding flow. This preserves the AGENTS.md invariant:
 * "Do not silently route customer traffic to a new paid provider or fallback
 * path without explicit configuration and tests."
 *
 * Runs at cron time only, never at request time.
 */

import {
  fetchLiteLLMCatalog,
  mappedProvider,
  stripProviderPrefix,
  type LiteLLMEntry,
} from './litellm-source.js';
import { MODEL_REGISTRY } from '../src/models.js';
import { EMBEDDING_MODELS } from '../src/embedding-models.js';
import { isPrefixPassthroughCovered } from './propose-parked-models.js';

// Mirror sync-pricing's stale-generated-model guard so we don't propose IDs the
// provider never actually shipped (LiteLLM sometimes carries speculative rows).
const STALE_MODEL_PATTERNS: RegExp[] = [/(^|\.)claude-sonnet-4-7($|-)/];

function isStale(provider: string, model: string): boolean {
  if (provider !== 'anthropic' && provider !== 'bedrock') return false;
  return STALE_MODEL_PATTERNS.some((p) => p.test(model));
}

export interface DiscoveredModel {
  provider: string;
  model: string;
  kind: 'chat' | 'embedding';
  context_window: number | null;
}

export interface DriftReport {
  /**
   * HIGH-SIGNAL: new LiteLLM models that belong to a model FAMILY RouteShift
   * already routes (e.g. we carry `glm-5`, LiteLLM adds `glm-5-code` / `glm-5.1`).
   * These are the actionable "keep our families current" candidates.
   */
  newInTrackedFamily: DiscoveredModel[];
  /**
   * The long tail: LiteLLM models for a provider we proxy but NOT in a family we
   * carry (historical snapshots, regional/size variants, models we intentionally
   * skip). Kept as a count + list but hidden from the default report — surfacing
   * all of them every week is noise, not signal.
   */
  newOther: DiscoveredModel[];
  /**
   * In our registry but no longer listed by LiteLLM for a LiteLLM-tracked
   * provider. MISLEADING when our registry leads LiteLLM (the newest models lag
   * upstream), so this is opt-in (`--all`) and clearly labelled "review".
   */
  possiblyRemoved: Array<{ provider: string; model: string; kind: 'chat' | 'embedding' }>;
}

/**
 * Do two model ids belong to the same family? True when one is a version/variant
 * extension of the other at a token boundary — `glm-5` vs `glm-5-code`/`glm-5.1`,
 * `gpt-5.5` vs `gpt-5.5-pro`. Guards against `glm-5` matching `glm-50` by
 * requiring the char after the shared prefix to be a separator.
 */
export function sameFamily(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  if (!longer.startsWith(shorter)) return false;
  const boundary = longer.charAt(shorter.length);
  return boundary === '-' || boundary === '.' || boundary === ':' || boundary === '_';
}

/** Lower-cased id set of everything the proxy already knows how to route. */
function knownModelIds(): { chat: Set<string>; embedding: Set<string> } {
  const chat = new Set<string>();
  for (const m of MODEL_REGISTRY) {
    chat.add(m.canonical_name.toLowerCase());
    chat.add(m.api_model_id.toLowerCase());
  }
  const embedding = new Set<string>();
  for (const [key, m] of Object.entries(EMBEDDING_MODELS)) {
    embedding.add(key.toLowerCase());
    embedding.add(m.api_model_id.toLowerCase());
  }
  return { chat, embedding };
}

/**
 * Providers RouteShift routes but that LiteLLM does NOT track per-token (their
 * absence from LiteLLM is not evidence of deprecation). Exclude them from the
 * "possibly removed" pass to avoid false alarms.
 */
const NON_LITELLM_PROVIDERS = new Set(['xiaomi']);

/** Registry model ids grouped by provider, for family matching. */
function registryIdsByProvider(): Map<string, string[]> {
  const byProvider = new Map<string, string[]>();
  for (const m of MODEL_REGISTRY) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider)!.push(m.canonical_name, m.api_model_id);
  }
  return byProvider;
}

export function computeDrift(catalog: Record<string, LiteLLMEntry>): DriftReport {
  const known = knownModelIds();
  const registryByProvider = registryIdsByProvider();

  const newModels: DiscoveredModel[] = [];
  const seen = new Set<string>();
  // Everything LiteLLM lists per (provider, id), so we can diff the other way.
  const litellmChatIds = new Map<string, Set<string>>();
  const litellmEmbeddingIds = new Map<string, Set<string>>();

  for (const [key, entry] of Object.entries(catalog)) {
    if (key === 'sample_spec') continue;
    const provider = mappedProvider(entry);
    if (!provider) continue;

    const kind: 'chat' | 'embedding' | null =
      entry.mode === 'chat' ? 'chat' : entry.mode === 'embedding' ? 'embedding' : null;
    if (!kind) continue;

    const model = stripProviderPrefix(key);
    if (isStale(provider, model)) continue;

    const idSet = kind === 'chat' ? litellmChatIds : litellmEmbeddingIds;
    if (!idSet.has(provider)) idSet.set(provider, new Set());
    idSet.get(provider)!.add(model.toLowerCase());

    const knownSet = kind === 'chat' ? known.chat : known.embedding;
    if (knownSet.has(model.toLowerCase())) continue;

    const dedupe = `${kind}:${provider}:${model.toLowerCase()}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    newModels.push({
      provider,
      model,
      kind,
      context_window: entry.max_input_tokens ?? entry.max_tokens ?? null,
    });
  }

  // Reverse diff: registry entries whose provider IS LiteLLM-tracked but whose
  // id no longer appears in LiteLLM. Report-only (LiteLLM can lag a fresh
  // registry add), clearly labelled as "review", never auto-removed.
  const possiblyRemoved: DriftReport['possiblyRemoved'] = [];
  for (const m of MODEL_REGISTRY) {
    if (NON_LITELLM_PROVIDERS.has(m.provider)) continue;
    const providerSet = litellmChatIds.get(m.provider);
    if (!providerSet || providerSet.size === 0) continue; // provider not in LiteLLM this run — inconclusive
    const inLiteLLM =
      providerSet.has(m.canonical_name.toLowerCase()) || providerSet.has(m.api_model_id.toLowerCase());
    if (!inLiteLLM) {
      possiblyRemoved.push({ provider: m.provider, model: m.canonical_name, kind: 'chat' });
    }
  }

  const bySortKey = (a: DiscoveredModel, b: DiscoveredModel) =>
    a.provider === b.provider ? a.model.localeCompare(b.model) : a.provider.localeCompare(b.provider);

  // Split new models into "belongs to a family we already route" (high signal)
  // vs the long tail (count only). Prefix-passthrough-covered ids STAY in the
  // report: the workflow's onboarding-issue trigger counts newInTrackedFamily,
  // and covered ids are exactly the ones that need "priced manual onboarding"
  // (parking them would revoke working requests, pinned by
  // tests/proxy-handler-basic.test.ts). renderMarkdown keeps them out of the
  // parked paste block and lists them under their own note instead.
  const newInTrackedFamily: DiscoveredModel[] = [];
  const newOther: DiscoveredModel[] = [];
  for (const m of newModels) {
    const registryIds = registryByProvider.get(m.provider) ?? [];
    const tracked = registryIds.some((rid) => sameFamily(rid, m.model));
    (tracked ? newInTrackedFamily : newOther).push(m);
  }
  newInTrackedFamily.sort(bySortKey);
  newOther.sort(bySortKey);
  return { newInTrackedFamily, newOther, possiblyRemoved };
}

/** Ready-to-paste PARKED ModelDefinition snippet for a discovered chat model. */
function parkedSnippet(m: DiscoveredModel): string {
  const ctx = m.context_window ?? 0;
  return `  { provider: '${m.provider}', canonical_name: '${m.model}', api_model_id: '${m.model}', context_window: ${ctx}, auto_route: false, public: false },`;
}

export function renderMarkdown(report: DriftReport, opts: { all?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push('## Model-catalog drift report');
  lines.push('');
  lines.push(
    'Generated by `detect-model-drift.ts`. Candidates are proposed **parked** ' +
      '(`auto_route: false, public: false`) — they never route customer traffic ' +
      'until a human promotes them via the provider-onboarding flow. Pricing is ' +
      'handled separately by the weekly `sync-pricing` cron.',
  );
  lines.push('');

  const tracked = report.newInTrackedFamily;
  if (tracked.length === 0) {
    lines.push('### ✅ No new models in a family you already route.');
  } else {
    const chat = tracked.filter((m) => m.kind === 'chat');
    const emb = tracked.filter((m) => m.kind === 'embedding');
    // Prefix-passthrough-covered ids stay in the report (they drive the
    // workflow's onboarding-issue trigger) but are excluded from the parked
    // paste block: parking an exact match would revoke working requests.
    const parkableChat = chat.filter((m) => !isPrefixPassthroughCovered(m.model));
    const coveredChat = chat.filter((m) => isPrefixPassthroughCovered(m.model));
    lines.push(`### 🆕 ${tracked.length} new model(s) in families you already route`);
    lines.push('');
    lines.push('| provider | model | kind | context |');
    lines.push('|---|---|---|---|');
    for (const m of tracked) {
      lines.push(`| ${m.provider} | \`${m.model}\` | ${m.kind} | ${m.context_window ?? '?'} |`);
    }
    if (chat.length > 0) {
      lines.push('');
      lines.push('Parked `MODEL_REGISTRY` entries to review + paste into `packages/shared/src/models.ts`:');
      lines.push('');
      lines.push('```ts');
      for (const m of parkableChat) lines.push(parkedSnippet(m));
      lines.push('```');
    }
    if (coveredChat.length > 0) {
      lines.push('');
      lines.push(`### \u26a0\ufe0f ${coveredChat.length} prefix-passthrough-covered id(s) — NOT parked, left to priced manual onboarding`);
      lines.push('');
      lines.push(
        'These resolve via the proxy\'s prefix passthrough today; parking them would install an exact match that ' +
          'revokes working requests (pinned by tests/proxy-handler-basic.test.ts). Promote them as public, priced ' +
          'registry entries via the provider-onboarding flow instead:',
      );
      lines.push('');
      for (const m of coveredChat) {
        lines.push(`- ${m.provider}: \`${m.model}\``);
      }
    }
    if (emb.length > 0) {
      lines.push('');
      lines.push(`Plus ${emb.length} embedding model(s) for \`EMBEDDING_MODELS\` — add by hand after verifying dimensions.`);
    }
  }

  lines.push('');
  lines.push(
    `_Long tail: ${report.newOther.length} other LiteLLM model(s) for your providers not in a family you carry ` +
      '(historical/regional/size variants). Run `detect-models --all` to list them._',
  );

  if (opts.all && report.newOther.length > 0) {
    lines.push('');
    lines.push('<details><summary>All other LiteLLM models (long tail)</summary>');
    lines.push('');
    for (const m of report.newOther) lines.push(`- ${m.provider}: \`${m.model}\` (${m.kind})`);
    lines.push('');
    lines.push('</details>');
  }

  if (opts.all && report.possiblyRemoved.length > 0) {
    lines.push('');
    lines.push(`### ⚠️ ${report.possiblyRemoved.length} registry model(s) not found in LiteLLM (review — often just LiteLLM lag on the newest models, NOT deprecation)`);
    lines.push('');
    for (const m of report.possiblyRemoved) lines.push(`- ${m.provider}: \`${m.model}\``);
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const all = process.argv.includes('--all');
  const catalog = await fetchLiteLLMCatalog();
  const report = computeDrift(catalog);

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2));
    return;
  }
  process.stdout.write(renderMarkdown(report, { all }));
  process.stdout.write(
    `\nSUMMARY: ${report.newInTrackedFamily.length} new-in-tracked-family, ` +
      `${report.newOther.length} long-tail, ${report.possiblyRemoved.length} possibly-removed\n`,
  );
}

// Only run when invoked directly (not when imported by the unit test).
const invokedDirectly = process.argv[1]?.endsWith('detect-model-drift.ts');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('detect-model-drift failed:', err);
    process.exit(1);
  });
}
