import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getModelPricing } from '@routeshift/shared';
import { collectDemoProviderKeyProviders, generateDemoDataset } from '@/lib/demo-data';
import { CURRENT_MODELS, requireCurrentModel } from '@/lib/current-models';
import { DEMO_TEAM_ID, DEMO_USER_ID, DEMO_USER_EMAIL } from '@/lib/demo-constants';
import { DEMO_ROUTING_RULES } from '@/lib/demo-rules';

const CURRENT = {
  default: requireCurrentModel('default'),
  economy: requireCurrentModel('economy'),
  coding: requireCurrentModel('coding'),
  reasoning: requireCurrentModel('reasoning'),
} as const;

const NOW = Date.UTC(2026, 4, 31, 12, 0, 0); // fixed clock for determinism

describe('generateDemoDataset (legacy single-pool path)', () => {
  const ds = generateDemoDataset({ now: NOW, seed: 12345, days: 30, targetRequests: 4000 });

  it('produces a substantial, non-empty dataset', () => {
    expect(ds.requestLogs.length).toBeGreaterThan(1000);
    expect(ds.sessions.length).toBeGreaterThan(50);
    expect(ds.apiKeys).toHaveLength(3);
  });

  it('is deterministic for the same now+seed', () => {
    const ds2 = generateDemoDataset({ now: NOW, seed: 12345, days: 30, targetRequests: 4000 });
    expect(ds2.requestLogs.length).toBe(ds.requestLogs.length);
    expect(ds2.requestLogs[0]).toEqual(ds.requestLogs[0]);
    expect(ds2.requestLogs.at(-1)).toEqual(ds.requestLogs.at(-1));
  });
});

describe('generateDemoDataset (25-user hero persona spectrum)', () => {
  // Hero profile preserves the original high-spend 25-user persona spectrum.
  const ds = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'hero' });

  it('produces a substantial, non-empty dataset', () => {
    expect(ds.requestLogs.length).toBeGreaterThan(1000);
    expect(ds.sessions.length).toBeGreaterThan(50);
  });

  it('is deterministic for the same now+seed', () => {
    const ds2 = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'hero' });
    expect(ds2.requestLogs.length).toBe(ds.requestLogs.length);
    expect(ds2.users.length).toBe(ds.users.length);
    expect(ds2.requestLogs[0]).toEqual(ds.requestLogs[0]);
    expect(ds2.requestLogs.at(-1)).toEqual(ds.requestLogs.at(-1));
  }, 20_000);

  it('seeds exactly 25 users with the demo owner first', () => {
    expect(ds.users).toHaveLength(25);
    expect(ds.users[0]!.id).toBe(DEMO_USER_ID);
    expect(ds.users[0]!.email).toBe(DEMO_USER_EMAIL);
    // emails + ids unique
    expect(new Set(ds.users.map((u) => u.id)).size).toBe(25);
    expect(new Set(ds.users.map((u) => u.email)).size).toBe(25);
  });

  it('maps every user to a team membership with valid roles', () => {
    expect(ds.teamMembers).toHaveLength(25);
    const memberIds = new Set(ds.teamMembers.map((m) => m.user_id));
    for (const u of ds.users) expect(memberIds.has(u.id)).toBe(true);
    expect(ds.teamMembers.every((m) => m.team_id === DEMO_TEAM_ID)).toBe(true);
    const owner = ds.teamMembers.filter((m) => m.role === 'owner');
    const admins = ds.teamMembers.filter((m) => m.role === 'admin');
    expect(owner).toHaveLength(1);
    expect(owner[0]!.user_id).toBe(DEMO_USER_ID);
    expect(admins.length).toBeGreaterThanOrEqual(2);
  });

  it('references only existing api keys from request logs', () => {
    const keyIds = new Set(ds.apiKeys.map((k) => k.id));
    expect(keyIds.size).toBeGreaterThan(0);
    // Aggregate (not per-row expect) — the persona dataset has ~1.8M rows.
    const orphan = ds.requestLogs.find((r) => !keyIds.has(r.api_key_id));
    expect(orphan).toBeUndefined();
  });

  it('keeps cost math internally consistent on every row', () => {
    // Quality-cascade rows are the one legitimate exception to original >=
    // actual: a cascade bills the aggregate of ALL dispatched attempts, so a
    // rejected primary plus a served fallback can cost more than the baseline
    // single-dispatch price (mirrors proxy aggregate settlement, RSH-134 §4.3).
    // Exempt exactly the two known cascade fixtures by id — a prefix match on
    // 'quality_gate_' would let any future fixture silently opt out of this guard.
    const CASCADE_ROW_IDS = new Set([
      'req_demo_scenario_quality_cascade',
      'req_demo_scenario_quality_cascade_exhausted',
    ]);
    const bad = ds.requestLogs.find(
      (r) =>
        r.savings_microcents !== Math.max(0, r.original_cost_microcents - r.actual_cost_microcents) ||
        (!CASCADE_ROW_IDS.has(r.id) && r.original_cost_microcents < r.actual_cost_microcents) ||
        r.actual_cost_microcents < 0,
    );
    expect(bad).toBeUndefined();
  });

  it('keeps token sums and system-prompt bounds valid', () => {
    const bad = ds.requestLogs.find(
      (r) =>
        r.total_tokens !== r.input_tokens + r.output_tokens ||
        r.system_prompt_tokens > r.input_tokens ||
        r.input_tokens <= 0,
    );
    expect(bad).toBeUndefined();
  });

  it('places every timestamp inside the 30-day window', () => {
    const start = NOW - 30 * 24 * 60 * 60 * 1000;
    const bad = ds.requestLogs.find((r) => {
      const t = r.timestamp.getTime();
      return t < start || t > NOW;
    });
    expect(bad).toBeUndefined();
  });

  it('scopes all rows to the demo team', () => {
    expect(ds.requestLogs.every((r) => r.team_id === DEMO_TEAM_ID)).toBe(true);
    expect(ds.sessions.every((s) => s.team_id === DEMO_TEAM_ID)).toBe(true);
    expect(ds.apiKeys.every((k) => k.team_id === DEMO_TEAM_ID)).toBe(true);
  });

  it('lands total spend in the realistic team band (~$100k–130k list / ~$80k+ actual)', () => {
    // Heavy + moderate users stop at their dollar target; light users stop at
    // their session cap (cheap-tier economics make their dollar band
    // unreachable without unrealistic volume), so they contribute little. The
    // dominant heavy+moderate targets put ACTUAL (post-routing) spend in the
    // $70k–110k band and ORIGINAL (pre-routing list) spend in the headline
    // $100k–130k band — within ~10% of the summed heavy+moderate targets.
    const usd = (n: number) => n / 100_000_000;
    const actualUsd = usd(ds.requestLogs.reduce((s, r) => s + r.actual_cost_microcents, 0));
    const originalUsd = usd(ds.requestLogs.reduce((s, r) => s + r.original_cost_microcents, 0));
    // Summed heavy+moderate target band: [5k*10+1k*6 .. 12k*10+3k*6] = [56k..138k].
    expect(actualUsd).toBeGreaterThanOrEqual(56_000 * 0.9);
    expect(actualUsd).toBeLessThanOrEqual(138_000 * 1.1);
    expect(originalUsd).toBeGreaterThan(actualUsd); // routing + cache produce savings
    expect(originalUsd).toBeGreaterThanOrEqual(90_000);
  });

  it('has a realistic status mix (mostly success, some errors, some cache hits)', () => {
    const total = ds.requestLogs.length;
    const ok = ds.requestLogs.filter((r) => r.status_code < 400).length;
    const errors = ds.requestLogs.filter((r) => r.status_code >= 400).length;
    const cached = ds.requestLogs.filter((r) => r.cache_hit).length;
    const savingsTotal = ds.requestLogs.reduce((s, r) => s + r.savings_microcents, 0);
    expect(ok / total).toBeGreaterThan(0.9);
    expect(errors).toBeGreaterThan(0);
    expect(cached).toBeGreaterThan(0);
    expect(savingsTotal).toBeGreaterThan(0);
  });

  it('spans multiple providers and includes uncategorized rows', () => {
    const providers = new Set(ds.requestLogs.map((r) => r.provider));
    expect(providers.size).toBeGreaterThanOrEqual(2);
    expect(ds.requestLogs.some((r) => r.activity_category === null)).toBe(true);
    expect(ds.requestLogs.some((r) => r.activity_category !== null)).toBe(true);
  });

  it('exercises the current default-role savings story', () => {
    const premiumRequests = ds.requestLogs.filter((r) => r.model_requested === CURRENT_MODELS.default);
    expect(premiumRequests.length).toBeGreaterThan(0);
    // Some current default-role traffic is routed down to a cheaper model,
    // producing positive substitution savings.
    const premiumSavings = premiumRequests.reduce((s, r) => s + r.savings_microcents, 0);
    expect(premiumSavings).toBeGreaterThan(0);
    expect(premiumRequests.some((r) => r.model_resolved !== r.model_requested)).toBe(true);
  });

  it('keeps session one_shot_rate null or within [0,1]', () => {
    const bad = ds.sessions.find(
      (s) =>
        (s.one_shot_rate !== null && (s.one_shot_rate < 0 || s.one_shot_rate > 1)) ||
        s.total_cost_microcents < 0 || s.billed_cost_microcents < 0 ||
        s.billed_cost_microcents < s.total_cost_microcents,
    );
    expect(bad).toBeUndefined();
  });
});


describe('generateDemoDataset profiles', () => {
  it('small profile is bounded but still populates core demo surfaces', () => {
    const ds = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'small' });
    expect(ds.users).toHaveLength(5);
    expect(ds.requestLogs.length).toBeGreaterThan(500);
    expect(ds.requestLogs.length).toBeLessThan(10_000);
    expect(ds.sessions.length).toBeGreaterThan(20);
    expect(new Set(ds.requestLogs.map((r) => r.model_resolved)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(ds.requestLogs.map((r) => r.timestamp.toISOString().slice(0, 10))).size).toBeGreaterThanOrEqual(7);
    expect(ds.requestLogs.reduce((s, r) => s + r.savings_microcents, 0)).toBeGreaterThan(0);
    expect(ds.requestLogs.some((r) => r.cache_hit)).toBe(true);
    expect(ds.requestLogs.some((r) => r.status_code >= 400)).toBe(true);
  });

  it('standard profile remains substantially smaller than hero for seedability', () => {
    const standard = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'standard' });
    const hero = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'hero' });
    expect(standard.users).toHaveLength(25);
    expect(standard.requestLogs.length).toBeGreaterThan(10_000);
    expect(standard.requestLogs.length).toBeLessThan(150_000);
    expect(hero.requestLogs.length).toBeGreaterThan(standard.requestLogs.length);
  }, 20_000);

  it('keeps demo user ids stable when changing profile size', () => {
    const small = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'small' });
    const standard = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'standard' });
    const standardIdsByEmail = new Map(standard.users.map((u) => [u.email, u.id]));
    for (const user of small.users) {
      expect(standardIdsByEmail.get(user.email)).toBe(user.id);
    }
  });
});

function aggregateSavingsSeries(ds: ReturnType<typeof generateDemoDataset>, month: string) {
  const rows = new Map<string, { day: string; original_microcents: number; actual_microcents: number; savings_microcents: number; requests: number }>();
  for (const r of ds.requestLogs) {
    const day = r.timestamp.toISOString().slice(0, 10);
    if (!day.startsWith(`${month}-`)) continue;
    const row = rows.get(day) ?? { day, original_microcents: 0, actual_microcents: 0, savings_microcents: 0, requests: 0 };
    row.original_microcents += r.original_cost_microcents;
    row.actual_microcents += r.actual_cost_microcents;
    row.savings_microcents += Math.max(r.savings_microcents, 0);
    row.requests += 1;
    rows.set(day, row);
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function aggregateByModelDay(ds: ReturnType<typeof generateDemoDataset>, month: string) {
  const rows = new Map<string, { day: string; model: string; input_tokens: number; output_tokens: number; total_tokens: number; actual_cost_microcents: number; request_count: number }>();
  for (const r of ds.requestLogs) {
    const day = r.timestamp.toISOString().slice(0, 10);
    if (!day.startsWith(`${month}-`)) continue;
    const key = `${day}|${r.model_resolved}`;
    const row = rows.get(key) ?? { day, model: r.model_resolved, input_tokens: 0, output_tokens: 0, total_tokens: 0, actual_cost_microcents: 0, request_count: 0 };
    row.input_tokens += r.input_tokens;
    row.output_tokens += r.output_tokens;
    row.total_tokens += r.total_tokens;
    row.actual_cost_microcents += r.actual_cost_microcents;
    row.request_count += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || b.actual_cost_microcents - a.actual_cost_microcents || a.model.localeCompare(b.model));
}

describe('generateDemoDataset usage endpoint coverage', () => {
  const month = '2026-05';
  const ds = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'small' });

  it('populates savings-series shape for the current month', () => {
    const series = aggregateSavingsSeries(ds, month);
    expect(series.length).toBeGreaterThanOrEqual(7);
    expect(series.reduce((s, row) => s + row.requests, 0)).toBeGreaterThan(0);
    expect(series.reduce((s, row) => s + row.savings_microcents, 0)).toBeGreaterThan(0);
    expect(series.every((row) => Number.isFinite(row.actual_microcents) && Number.isFinite(row.savings_microcents))).toBe(true);
  });

  it('populates by-model-day shape for the current month', () => {
    const records = aggregateByModelDay(ds, month);
    expect(records.length).toBeGreaterThanOrEqual(10);
    expect(new Set(records.map((r) => r.day)).size).toBeGreaterThanOrEqual(7);
    expect(new Set(records.map((r) => r.model)).size).toBeGreaterThanOrEqual(3);
    expect(records.every((r) => r.total_tokens === r.input_tokens + r.output_tokens)).toBe(true);
    expect(records.every((r) => Number.isFinite(r.actual_cost_microcents) && r.request_count > 0)).toBe(true);
  });

  it('is stable for usage endpoint aggregates', () => {
    const again = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'small' });
    expect(aggregateSavingsSeries(again, month)).toEqual(aggregateSavingsSeries(ds, month));
    expect(aggregateByModelDay(again, month)).toEqual(aggregateByModelDay(ds, month));
  });

  it('can intentionally populate current and previous calendar months for seeded dashboards', () => {
    const calendar = generateDemoDataset({ now: NOW, seed: 12345, profile: 'small', includePreviousMonth: true });
    expect(aggregateSavingsSeries(calendar, '2026-04').length).toBeGreaterThan(0);
    expect(aggregateSavingsSeries(calendar, '2026-05').length).toBeGreaterThan(0);
    expect(aggregateByModelDay(calendar, '2026-04').length).toBeGreaterThan(0);
    expect(aggregateByModelDay(calendar, '2026-05').length).toBeGreaterThan(0);
  });

  it('includes deterministic narrative scenario markers for demos', () => {
    const scenarioIds = new Set(ds.requestLogs.map((r) => r.id));
    expect(scenarioIds.has('req_demo_scenario_premium_routed')).toBe(true);
    expect(scenarioIds.has('req_demo_scenario_rate_limited_key')).toBe(true);
    expect(scenarioIds.has('req_demo_scenario_provider_fallback')).toBe(true);
    expect(scenarioIds.has('req_demo_scenario_oversized_system_prompt')).toBe(true);
    expect(scenarioIds.has('req_demo_scenario_quality_cascade')).toBe(true);
    expect(scenarioIds.has('req_demo_scenario_quality_cascade_exhausted')).toBe(true);
    expect(ds.requestLogs.filter((r) => r.id.startsWith('req_demo_scenario_cache_after_')).every((r) => r.cache_hit)).toBe(true);
    expect(ds.requestLogs.filter((r) => r.message_hash === 'demohash_scenario_duplicate_uncached')).toHaveLength(2);
    expect(ds.requestLogs.find((r) => r.id === 'req_demo_scenario_rate_limited_key')?.status_code).toBe(429);
    expect(ds.requestLogs.find((r) => r.id === 'req_demo_scenario_provider_fallback')?.is_fallback).toBe(true);
    expect(ds.requestLogs.find((r) => r.id === 'req_demo_scenario_premium_routed')?.savings_microcents).toBeGreaterThan(0);
  });

  it('seeds quality-cascade scenario rows matching proxy cascade accounting exactly (RSH-154)', () => {
    // Mirrors demo-data's costMicrocents via the shared pricing source of truth.
    const price = (provider: string, model: string, inputTokens: number, outputTokens: number) => {
      const p = getModelPricing(provider, model);
      expect(p, `pricing for ${provider}/${model}`).toBeTruthy();
      return Math.round(
        ((inputTokens / 1_000_000) * p!.input_per_million + (outputTokens / 1_000_000) * p!.output_per_million) *
          100_000_000,
      );
    };

    const served = ds.requestLogs.find((r) => r.id === 'req_demo_scenario_quality_cascade');
    expect(served).toBeTruthy();
    expect(served!.is_streaming).toBe(false);
    expect(served!.is_fallback).toBe(true);
    expect(served!.status_code).toBe(200);
    // Consistent with rule_demo_quality_gate: default primary, coding fallback.
    expect(served!.model_requested).toBe(CURRENT.default.canonical_name);
    expect(served!.model_resolved).toBe(CURRENT.coding.canonical_name);
    expect(served!.fallback_attempts).toEqual([
      { provider: CURRENT.default.provider, model: CURRENT.default.canonical_name, error: 'quality_gate_empty_content', actual_cost_known: true },
    ]);
    // Row tokens = served + prior attempts; the empty-content primary produced
    // ~0 output tokens but still bills its input.
    expect(served!.input_tokens).toBe(96_000);
    expect(served!.output_tokens).toBe(5_200);
    expect(served!.original_cost_microcents).toBe(price(CURRENT.default.provider, CURRENT.default.canonical_name, 48_000, 5_200));
    expect(served!.actual_cost_microcents).toBe(
      price(CURRENT.default.provider, CURRENT.default.canonical_name, 48_000, 0) + price(CURRENT.coding.provider, CURRENT.coding.canonical_name, 48_000, 5_200),
    );
    // Aggregate billing: actual strictly exceeds the served attempt alone.
    expect(served!.actual_cost_microcents).toBeGreaterThan(
      price(CURRENT.coding.provider, CURRENT.coding.canonical_name, 48_000, 5_200),
    );

    const exhausted = ds.requestLogs.find((r) => r.id === 'req_demo_scenario_quality_cascade_exhausted');
    expect(exhausted).toBeTruthy();
    expect(exhausted!.is_streaming).toBe(false);
    expect(exhausted!.status_code).toBe(502);
    expect(exhausted!.error_type).toBe('quality_gate_exhausted');
    expect(exhausted!.model_requested).toBe(CURRENT.default.canonical_name);
    expect(exhausted!.model_resolved).toBe(CURRENT.default.canonical_name);
    // Terminal failure: the proxy logs original = 0, savings = 0, aggregate
    // tokens across dispatched attempts, and the aggregate actual cost.
    expect(exhausted!.original_cost_microcents).toBe(0);
    expect(exhausted!.savings_microcents).toBe(0);
    expect(exhausted!.input_tokens).toBe(24_000);
    expect(exhausted!.output_tokens).toBe(1_800);
    expect(exhausted!.actual_cost_microcents).toBe(
      price(CURRENT.default.provider, CURRENT.default.canonical_name, 12_000, 900) + price(CURRENT.coding.provider, CURRENT.coding.canonical_name, 12_000, 900),
    );
    expect(exhausted!.fallback_attempts!.map((a) => a.error)).toEqual([
      'quality_gate_max_tokens',
      'quality_gate_max_tokens',
    ]);
  });

  it('correlates latency with cache, fallback, and model tier', () => {
    const cacheHits = ds.requestLogs.filter((r) => r.cache_hit);
    const misses = ds.requestLogs.filter((r) => !r.cache_hit && !r.is_fallback && r.status_code < 400);
    const fallbacks = ds.requestLogs.filter((r) => r.is_fallback);
    const cheap = misses.filter((r) => r.model_resolved === CURRENT.economy.canonical_name);
    const premium = misses.filter((r) => r.model_requested === CURRENT.default.canonical_name || r.model_requested === CURRENT.reasoning.canonical_name);
    const avg = (rows: typeof ds.requestLogs) => rows.reduce((sum, row) => sum + row.total_latency_ms, 0) / rows.length;

    expect(cacheHits.length).toBeGreaterThan(0);
    expect(misses.length).toBeGreaterThan(0);
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(avg(cacheHits)).toBeLessThan(avg(misses));
    expect(avg(fallbacks)).toBeGreaterThan(avg(misses));
    expect(avg(premium)).toBeGreaterThan(avg(cheap));
  });
});

describe('demo data ClickHouse posture', () => {
  it('documents Postgres-only demo analytics with explicit health failure when ClickHouse is enabled', async () => {
    const fs = await import('node:fs');
    const script = fs.readFileSync(new URL('../scripts/check-demo-data.ts', import.meta.url), 'utf8');
    expect(script).toContain('CLICKHOUSE_URL is configured, but RouteShift demo analytics are Postgres-only');
  });
});

describe('demo seed script guardrails', () => {
  it('rejects --profile when the following token is another flag', async () => {
    const fs = await import('node:fs');
    const script = fs.readFileSync(new URL('../scripts/seed-demo.ts', import.meta.url), 'utf8');
    expect(script).toContain("next && !next.startsWith('--') ? next : undefined");
  });

  it('scales hard-coded optimize finding copy through the selected profile', async () => {
    const fs = await import('node:fs');
    const script = fs.readFileSync(new URL('../scripts/seed-demo.ts', import.meta.url), 'utf8');
    expect(script).toContain('function buildOptimizeFindings(now: number, profile: DemoSeedProfile): DemoFinding[]');
    expect(script).toContain('findingScaleForProfile(profile)');
    expect(script).not.toContain('18,200 requests');
  });

  it('preserves DB health output when proxy endpoint fetches throw', async () => {
    const fs = await import('node:fs');
    const script = fs.readFileSync(new URL('../scripts/check-demo-data.ts', import.meta.url), 'utf8');
    expect(script).toContain('proxy endpoint checks failed');
    expect(script).toContain('catch (err)');
  });

  it('seeded cascade fallback_attempts survive the logs read path round-trip (RSH-154)', async () => {
    // Real round-trip instead of source-grep: apply the seed's exact mapping
    // (JSON.stringify of the row's attempts) and feed the result through the
    // same normalizeFallbackAttempts the /api/logs route uses. Catches column/
    // mapper drift and any write shape the read path would drop.
    const { normalizeFallbackAttempts } = await import('@/lib/log-attempts');
    const ds = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'small' });
    const cascadeRows = ds.requestLogs.filter((r) => (r.fallback_attempts ?? []).length > 0);
    expect(cascadeRows.length).toBeGreaterThan(0);
    for (const row of cascadeRows) {
      const stored = JSON.stringify(row.fallback_attempts ?? []);
      expect(normalizeFallbackAttempts(stored)).toEqual(row.fallback_attempts);
    }
  });

  it('seeds a quality-gated demo rule whose gate is storable under the proxy write-gate (RSH-154)', async () => {
    // Validates the REAL seeded fixture (imported, not a hand-copied literal),
    // with the same strict validator the proxy admin write-gate runs.
    const { DEMO_ROUTING_RULES } = await import('@/lib/demo-rules');
    const { validateQualityGateConfig } = await import('@routeshift/shared');
    const gated = DEMO_ROUTING_RULES.find((r) => r.id === 'rule_demo_quality_gate');
    expect(gated).toBeTruthy();
    expect(gated!.enabled).toBe(true);
    expect(gated!.action.type).toBe('route');
    const result = validateQualityGateConfig(gated!.action.quality_gate);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.multi_attempt_billing_ack).toBe(true);
  });

  it('keeps the degraded-provider rule fallback on a different current-role provider', () => {
    const degraded = DEMO_ROUTING_RULES.find((rule) => rule.id === 'rule_demo_opus_fallback');
    expect(degraded).toBeTruthy();
    const action = degraded?.action as {
      target_provider?: string;
      fallback_chain?: Array<{ provider?: string; model?: string }>;
    };
    expect(action.target_provider).toBe(CURRENT.reasoning.provider);
    expect(action.fallback_chain).toEqual([
      {
        provider: CURRENT.coding.provider,
        model: CURRENT.coding.canonical_name,
      },
    ]);
    expect(action.fallback_chain?.[0]?.provider).not.toBe(action.target_provider);
  });

  it('derives provider-key coverage from every demo fixture and rule provider, including Qwen', () => {
    const dataset = generateDemoDataset({ now: NOW, seed: 12345, days: 30, profile: 'small' });
    const providers = new Set(collectDemoProviderKeyProviders(dataset, DEMO_ROUTING_RULES));
    const fixtureProviders = new Set([
      ...dataset.requestLogs.map((row) => row.provider),
      ...dataset.requestLogs.flatMap((row) => (row.fallback_attempts ?? []).map((attempt) => attempt.provider)),
      ...Object.values(CURRENT).map((model) => model.provider),
    ]);
    for (const provider of fixtureProviders) {
      expect(providers.has(provider), `missing demo provider key for ${provider}`).toBe(true);
    }
    expect(providers.has('qwen')).toBe(true);
    const seedSource = readFileSync('scripts/seed-demo.ts', 'utf8');
    expect(seedSource).toContain('collectDemoProviderKeyProviders(ds, DEMO_ROUTING_RULES)');
    expect(seedSource).toContain('providerKeyRows');
  });

  it('keeps enabled demo rule conditions disjoint so no rule can shadow another (RSH-154)', async () => {
    // The evaluator returns the FIRST matching route action in ascending
    // priority order; two enabled rules with identical conditions would make
    // the higher-numbered one dead config (the round-2 review's shadowing P2).
    const { DEMO_ROUTING_RULES } = await import('@/lib/demo-rules');
    const stableKey = (value: unknown): string =>
      JSON.stringify(value, (_k, v) =>
        v && typeof v === 'object' && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
          : v,
      );
    const enabled = DEMO_ROUTING_RULES.filter((r) => r.enabled);
    const seen = new Map<string, string>();
    for (const rule of enabled) {
      const key = stableKey(rule.condition);
      const prior = seen.get(key);
      expect(prior, `condition collision: ${rule.id} shadows/shadowed by ${prior ?? ''}`).toBeUndefined();
      seen.set(key, rule.id);
    }
  });
});
