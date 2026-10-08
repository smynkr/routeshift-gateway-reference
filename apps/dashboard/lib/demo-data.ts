/**
 * Pure, deterministic generators for RouteShift demo data. No DB, no I/O — it
 * returns plain row objects that scripts/seed-demo.ts inserts. Kept pure so the
 * invariants (cost consistency, token sums, time window) are unit-testable
 * without a database (tests/demo-data.test.ts).
 *
 * Determinism: a seeded PRNG plus an injected `now` (epoch ms) means the same
 * inputs always produce the same dataset — re-running the seed is stable and
 * reviewable.
 *
 * Shape: a realistic TEAM OF 25 users across a spend spectrum. Each user has a
 * persona (heavy / moderate / light) with its own per-user monthly spend target
 * and model-tier mix, plus its own api key(s). request_logs.api_key_id always
 * points at one of that user's keys. The expensive frontier role is
 * preferentially routed down to cheaper models so "savings by model
 * substitution" is prominent in demo mode.
 */
import { EFFECTIVE_PUBLIC_MODELS, getModelPricing } from '@routeshift/shared';
import {
  CURRENT_MODEL_ROLES,
  CURRENT_MODELS,
  requireCurrentModel,
  type CurrentModelRole,
} from './current-models';
import { ACTIVITY_CATEGORIES } from './activity-categories';
import { DEMO_TEAM_ID, DEMO_USER_ID, DEMO_USER_EMAIL } from './demo-constants';
import type { DemoRoutingRule } from './demo-rules';

const MICROCENTS_PER_USD = 100_000_000;

export interface RequestLogRow {
  id: string;
  timestamp: Date;
  team_id: string;
  provider: string;
  model_requested: string;
  model_resolved: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  system_prompt_tokens: number;
  original_cost_microcents: number;
  actual_cost_microcents: number;
  savings_microcents: number;
  total_latency_ms: number;
  ttft_ms: number | null;
  is_streaming: boolean;
  is_fallback: boolean;
  status_code: number;
  error_type: string | null;
  cache_hit: boolean;
  rate_limited: boolean;
  activity_category: string | null;
  session_id: string;
  api_key_id: string;
  message_hash: string | null;
  edited_paths: string[] | null;
  had_bash: boolean;
  fallback_attempts?: Array<{ provider: string; model: string; error: string; actual_cost_known?: boolean }>;
}

export interface SessionMetricRow {
  session_id: string;
  team_id: string;
  edit_turns: number;
  retry_turns: number;
  one_shot_rate: number | null;
  primary_model: string;
  total_cost_microcents: number;
  billed_cost_microcents: number;
  first_request_at: Date;
  last_request_at: Date;
}

export interface ApiKeyRow {
  id: string;
  team_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  environment: string;
  created_at: Date;
  last_used: Date;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
}

export interface TeamMemberRow {
  user_id: string;
  team_id: string;
  role: string;
}

export interface DemoDataset {
  users: UserRow[];
  teamMembers: TeamMemberRow[];
  apiKeys: ApiKeyRow[];
  requestLogs: RequestLogRow[];
  sessions: SessionMetricRow[];
}

/**
 * Providers represented by deterministic model fixtures, persisted request
 * rows, fallback attempts, or routing rules. The seed consumes this projection
 * so every provider shown in demo mode has a corresponding BYOK row.
 */
export function collectDemoProviderKeyProviders(
  dataset: DemoDataset,
  rules: readonly DemoRoutingRule[],
): string[] {
  const providers = new Set<string>();
  for (const role of CURRENT_MODEL_ROLES) providers.add(requireCurrentModel(role).provider);
  for (const row of dataset.requestLogs) {
    providers.add(row.provider);
    for (const attempt of row.fallback_attempts ?? []) providers.add(attempt.provider);
  }
  for (const rule of rules) {
    const targetProvider = rule.action.target_provider;
    if (typeof targetProvider === 'string') providers.add(targetProvider);
    const fallbackChain = rule.action.fallback_chain;
    if (!Array.isArray(fallbackChain)) continue;
    for (const fallback of fallbackChain) {
      if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) continue;
      const provider = (fallback as Record<string, unknown>).provider;
      if (typeof provider === 'string') providers.add(provider);
    }
  }
  return [...providers].sort();
}

/** mulberry32 — small deterministic PRNG. Returns a function yielding [0,1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


function stableDemoUserId(index: number): string {
  if (index === 0) return DEMO_USER_ID;
  const suffix = (0x100 + index).toString(16).padStart(12, '0');
  return `d0000000-0000-4000-8000-${suffix}`;
}

const ERROR_TYPES = ['rate_limit_error', 'api_error', 'timeout', 'invalid_request_error'] as const;

// Hour-of-day weights: business hours busier. Index = UTC hour 0..23.
const HOUR_WEIGHTS = [
  1, 1, 1, 1, 1, 2, 3, 5, 8, 10, 11, 11, 10, 11, 11, 10, 9, 7, 5, 4, 3, 2, 2, 1,
];
// Weekday weights (0=Sun..6=Sat): weekdays busier.
const WEEKDAY_WEIGHTS = [3, 9, 10, 10, 10, 8, 3];

function weightedIndex(rng: () => number, weights: number[]): number {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

/** Log-normal-ish positive integer for token counts. */
function tokenAmount(rng: () => number, min: number, spread: number): number {
  // Bias toward the low end with an occasional fat tail.
  const r = rng();
  const base = min + r * r * spread;
  return Math.max(1, Math.round(base));
}


function latencyForRequest(args: {
  rng: () => number;
  tier: Tier;
  outputTokens: number;
  cacheHit: boolean;
  isFallback: boolean;
  status: number;
}): { latency: number; ttft: number | null; isStreaming: boolean } {
  if (args.cacheHit) {
    const latency = Math.round(80 + args.rng() * 220);
    return { latency, ttft: null, isStreaming: false };
  }

  const tierBase = args.tier === 'premium' ? 1_800 : args.tier === 'mid' ? 950 : 420;
  const outputFactor = args.tier === 'premium' ? 1.55 : args.tier === 'mid' ? 0.9 : 0.35;
  const fallbackPenalty = args.isFallback ? 1_700 + args.rng() * 1_100 : 0;
  const errorPenalty = args.status >= 500 ? 1_200 + args.rng() * 700 : 0;
  const jitter = args.rng() * (args.tier === 'premium' ? 1_200 : 650);
  const latency = Math.round(tierBase + args.outputTokens * outputFactor + fallbackPenalty + errorPenalty + jitter);
  const isStreaming = args.rng() < (args.tier === 'cheap' ? 0.45 : 0.68);
  const ttft = isStreaming
    ? Math.round(Math.min(latency - 50, tierBase * 0.25 + args.rng() * (args.isFallback ? 900 : 500)))
    : null;
  return { latency, ttft, isStreaming };
}

interface DemoModel {
  provider: string;
  canonical: string;
  inputPerM: number;
  outputPerM: number;
}
/**
 * Build the candidate model pool (auto-routable, priced models from the
 * headline providers). Explicit-only current role models are retained so
 * seeded narrative rows can continue to use the same current catalog roles.
 */
function buildModelPool(): DemoModel[] {
  const providers = new Set(['openai', 'anthropic', 'google']); // not-a-provider-allowlist — demo fixture subset
  const currentIds = new Set(Object.values(CURRENT_MODELS));
  const pool: DemoModel[] = [];
  for (const m of EFFECTIVE_PUBLIC_MODELS) {
    if (!providers.has(m.provider) && !currentIds.has(m.canonical_name)) continue;
    if (m.auto_route === false && !currentIds.has(m.canonical_name)) continue;
    const pricing = getModelPricing(m.provider, m.canonical_name)
      ?? (m.api_model_id === m.canonical_name ? null : getModelPricing(m.provider, m.api_model_id));
    if (!pricing) continue;
    pool.push({
      provider: m.provider,
      canonical: m.canonical_name,
      inputPerM: pricing.input_per_million,
      outputPerM: pricing.output_per_million,
    });
  }
  return pool;
}

function costMicrocents(model: DemoModel, inputTokens: number, outputTokens: number): number {
  const usd =
    (inputTokens / 1_000_000) * model.inputPerM + (outputTokens / 1_000_000) * model.outputPerM;
  return Math.round(usd * MICROCENTS_PER_USD);
}

/** A cheaper alternative model for routed rows (lower combined price), if any. */
function cheaperModel(rng: () => number, pool: DemoModel[], reference: DemoModel): DemoModel | null {
  const cheaper = pool.filter(
    (m) => m.outputPerM + m.inputPerM < reference.outputPerM + reference.inputPerM,
  );
  if (cheaper.length === 0) return null;
  return pick(rng, cheaper);
}

export type DemoSeedProfile = 'small' | 'standard' | 'hero';

export interface GenerateOptions {
  now: number;
  seed?: number;
  days?: number;
  /**
   * Fixed request-count target (legacy). Used when neither per-user personas
   * nor `targetSpendUsd` drive sizing — the unit tests pin this for stable,
   * fast datasets. When omitted the persona spectrum (25 users) is generated.
   */
  targetRequests?: number;
  /**
   * Realistic dollar target for the legacy single-pool path (kept for
   * back-compat callers). Ignored by the persona spectrum, which uses
   * per-user targets instead.
   */
  targetSpendUsd?: number;
  /** Size/shape preset for the persona spectrum path. Defaults to standard. */
  profile?: DemoSeedProfile;
  /**
   * When true, use a calendar demo window from the previous month start
   * through `now` instead of a rolling `days` window. This keeps current and
   * previous month dashboard filters populated after seeding.
   */
  includePreviousMonth?: boolean;
}

type Tier = 'cheap' | 'mid' | 'premium';

/**
 * A real team's spend is dominated by mid-tier coding models, with a long
 * tail of cheap models for simple tasks and occasional premium models for
 * hard problems — and the mix differs sharply by persona.
 */
function makeTieredModelPicker(
  pool: DemoModel[],
  weights: [number, number, number],
): (rng: () => number) => { model: DemoModel; tier: Tier } {
  const sorted = [...pool].sort(
    (a, b) => a.inputPerM + a.outputPerM - (b.inputPerM + b.outputPerM),
  );
  const n = sorted.length;
  const allTiers: { pool: DemoModel[]; w: number; tier: Tier }[] = [
    { pool: sorted.slice(0, Math.floor(n / 3)), w: weights[0], tier: 'cheap' },
    { pool: sorted.slice(Math.floor(n / 3), Math.floor((2 * n) / 3)), w: weights[1], tier: 'mid' },
    { pool: sorted.slice(Math.floor((2 * n) / 3)), w: weights[2], tier: 'premium' },
  ];
  const tiers = allTiers.filter((t) => t.pool.length > 0);

  return (rng: () => number) => {
    const total = tiers.reduce((s, t) => s + t.w, 0);
    let r = rng() * total;
    for (const t of tiers) {
      r -= t.w;
      if (r < 0) return { model: pick(rng, t.pool), tier: t.tier };
    }
    const last = tiers[tiers.length - 1]!;
    return { model: pick(rng, last.pool), tier: last.tier };
  };
}


function modelForRole(pool: DemoModel[], role: CurrentModelRole): DemoModel {
  const canonical = CURRENT_MODELS[role];
  const model = pool.find((candidate) => candidate.canonical === canonical);
  if (!model) {
    throw new Error(`current model ${role}=${canonical} is missing from the demo pool`);
  }
  return model;
}

function addScenarioSession(
  sessions: SessionMetricRow[],
  rows: RequestLogRow[],
  sessionId: string,
  primaryModel: string,
): void {
  if (rows.length === 0) return;
  const totalCost = rows.reduce((sum, row) => sum + row.actual_cost_microcents, 0);
  sessions.push({
    session_id: sessionId,
    team_id: DEMO_TEAM_ID,
    edit_turns: rows.filter((r) => Array.isArray(r.edited_paths) && r.edited_paths.length > 0).length,
    retry_turns: rows.filter((r) => r.message_hash?.includes('duplicate')).length,
    one_shot_rate: 0.72,
    primary_model: primaryModel,
    total_cost_microcents: totalCost,
    billed_cost_microcents: totalCost,
    first_request_at: rows[0]!.timestamp,
    last_request_at: rows[rows.length - 1]!.timestamp,
  });
}

/**
 * Deterministic narrative rows make demo charts tell recognizable stories:
 * premium-model routing savings, cache adoption, a rate-limited key, fallback
 * recovery, oversized system prompt, and duplicate requests. They are small in
 * volume but deliberately discoverable by filters and aggregate tests.
 */
function addNarrativeScenarioRows(params: {
  requestLogs: RequestLogRow[];
  sessions: SessionMetricRow[];
  apiKeys: ApiKeyRow[];
  pool: DemoModel[];
  now: number;
  windowStart: number;
}): void {
  const { requestLogs, sessions, apiKeys, pool, now, windowStart } = params;
  const key = apiKeys[0];
  if (!key) return;
  const dayMs = 24 * 60 * 60 * 1000;
  const at = (daysAgo: number, hour = 15) => new Date(Math.max(windowStart + 60_000, now - daysAgo * dayMs + hour * 60 * 60 * 1000));
  const pro = modelForRole(pool, 'default');
  const sonnet = modelForRole(pool, 'coding');
  const economy = modelForRole(pool, 'economy');
  // The current default role can be cheaper than the historical economy role
  // after a provider migration; keep the narrative's "routed down" invariant.
  const nano = cheaperModel(() => 0, pool, pro) ?? economy;
  const opus = modelForRole(pool, 'reasoning');
  const gpt = modelForRole(pool, 'coding');

  const row = (overrides: Partial<RequestLogRow> & Pick<RequestLogRow, 'id' | 'timestamp' | 'model_requested' | 'model_resolved' | 'provider' | 'input_tokens' | 'output_tokens' | 'actual_cost_microcents' | 'original_cost_microcents' | 'session_id'>): RequestLogRow => ({
    team_id: DEMO_TEAM_ID,
    total_tokens: overrides.input_tokens + overrides.output_tokens,
    system_prompt_tokens: Math.min(overrides.input_tokens, Math.round(overrides.input_tokens * 0.18)),
    savings_microcents: Math.max(0, overrides.original_cost_microcents - overrides.actual_cost_microcents),
    total_latency_ms: 1800,
    ttft_ms: 320,
    is_streaming: true,
    is_fallback: false,
    status_code: 200,
    error_type: null,
    cache_hit: false,
    rate_limited: false,
    activity_category: 'coding',
    api_key_id: key.id,
    message_hash: null,
    edited_paths: ['src/demo_scenario.ts'],
    had_bash: true,
    ...overrides,
  });

  const scenarioRows: RequestLogRow[] = [];

  // 1. Premium model routed down: big visible savings in model-substitution charts.
  scenarioRows.push(row({
    id: 'req_demo_scenario_premium_routed',
    timestamp: at(5),
    session_id: 'sess_demo_scenario_premium_routed',
    provider: nano.provider,
    model_requested: pro.canonical,
    model_resolved: nano.canonical,
    input_tokens: 180_000,
    output_tokens: 24_000,
    original_cost_microcents: costMicrocents(pro, 180_000, 24_000),
    actual_cost_microcents: costMicrocents(nano, 180_000, 24_000),
  }));

  // 2. Cache adoption improves after the midpoint: paired before/after rows.
  const cacheRows: RequestLogRow[] = [];
  for (let i = 0; i < 3; i++) {
    cacheRows.push(row({
      id: `req_demo_scenario_cache_before_${i}`,
      timestamp: at(20 - i),
      session_id: 'sess_demo_scenario_cache_adoption',
      provider: sonnet.provider,
      model_requested: sonnet.canonical,
      model_resolved: sonnet.canonical,
      input_tokens: 42_000,
      output_tokens: 6_000,
      original_cost_microcents: costMicrocents(sonnet, 42_000, 6_000),
      actual_cost_microcents: costMicrocents(sonnet, 42_000, 6_000),
      cache_hit: false,
      message_hash: 'demohash_scenario_cacheable_prompt',
    }));
    cacheRows.push(row({
      id: `req_demo_scenario_cache_after_${i}`,
      timestamp: at(4 - i),
      session_id: 'sess_demo_scenario_cache_adoption',
      provider: sonnet.provider,
      model_requested: sonnet.canonical,
      model_resolved: sonnet.canonical,
      input_tokens: 42_000,
      output_tokens: 6_000,
      original_cost_microcents: costMicrocents(sonnet, 42_000, 6_000),
      actual_cost_microcents: 0,
      cache_hit: true,
      message_hash: 'demohash_scenario_cacheable_prompt',
    }));
  }
  scenarioRows.push(...cacheRows);

  // 3. One abusive/leaked key hits rate limits.
  scenarioRows.push(row({
    id: 'req_demo_scenario_rate_limited_key',
    timestamp: at(3),
    session_id: 'sess_demo_scenario_rate_limited_key',
    provider: nano.provider,
    model_requested: nano.canonical,
    model_resolved: nano.canonical,
    input_tokens: 3_000,
    output_tokens: 500,
    original_cost_microcents: costMicrocents(nano, 3_000, 500),
    actual_cost_microcents: 0,
    status_code: 429,
    error_type: 'rate_limit_error',
    rate_limited: true,
    edited_paths: null,
    had_bash: false,
  }));

  // 4. Fallback incident recovers an Opus request onto GPT. The attempts list
  // carries the plain (non-quality) provider failure so the older fallback
  // story renders with the same attempt detail the cascade rows show.
  scenarioRows.push(row({
    id: 'req_demo_scenario_provider_fallback',
    timestamp: at(2),
    session_id: 'sess_demo_scenario_provider_fallback',
    provider: gpt.provider,
    model_requested: opus.canonical,
    model_resolved: gpt.canonical,
    input_tokens: 96_000,
    output_tokens: 11_000,
    original_cost_microcents: costMicrocents(gpt, 96_000, 11_000) + 10_000_000,
    actual_cost_microcents: costMicrocents(gpt, 96_000, 11_000),
    is_fallback: true,
    total_latency_ms: 5_800,
    ttft_ms: 1_400,
    fallback_attempts: [
      { provider: opus.provider, model: opus.canonical, error: 'HTTP 503' },
    ],
  }));

  // 4b. Quality-gated cascade (RSH-154), consistent with rule_demo_quality_gate
  // (default role primary, coding role fallback). The primary's response
  // fails the nonempty_content check — it produced ~0 output tokens but is still
  // billed — and the fallback serves. Row tokens/cost mirror the proxy exactly:
  // input/output = served + prior attempts, actual = aggregate of dispatched
  // attempts, original = requested-model baseline (proxy-handler.ts §3744).
  scenarioRows.push(row({
    id: 'req_demo_scenario_quality_cascade',
    timestamp: at(2, 9),
    session_id: 'sess_demo_scenario_quality_cascade',
    provider: sonnet.provider,
    model_requested: pro.canonical,
    model_resolved: sonnet.canonical,
    input_tokens: 96_000,
    output_tokens: 5_200,
    original_cost_microcents: costMicrocents(pro, 48_000, 5_200),
    actual_cost_microcents: costMicrocents(pro, 48_000, 0) + costMicrocents(sonnet, 48_000, 5_200),
    is_streaming: false,
    is_fallback: true,
    ttft_ms: null,
    total_latency_ms: 7_400,
    fallback_attempts: [
      { provider: pro.provider, model: pro.canonical, error: 'quality_gate_empty_content', actual_cost_known: true },
    ],
  }));

  // 4c. Failed quality cascade on the same gated rule: both candidates' outputs
  // were truncated, so the request errors with the exact terminal code. The
  // proxy logs terminal failures with original_cost = 0 and savings = 0 (nothing
  // was served, so there is no baseline comparison), aggregate tokens across
  // dispatched attempts, and the aggregate actual cost — spent attempts bill.
  scenarioRows.push(row({
    id: 'req_demo_scenario_quality_cascade_exhausted',
    timestamp: at(1, 11),
    session_id: 'sess_demo_scenario_quality_cascade_exhausted',
    provider: pro.provider,
    model_requested: pro.canonical,
    model_resolved: pro.canonical,
    input_tokens: 24_000,
    output_tokens: 1_800,
    original_cost_microcents: 0,
    actual_cost_microcents: costMicrocents(pro, 12_000, 900) + costMicrocents(sonnet, 12_000, 900),
    is_streaming: false,
    status_code: 502,
    error_type: 'quality_gate_exhausted',
    ttft_ms: null,
    total_latency_ms: 9_100,
    fallback_attempts: [
      { provider: pro.provider, model: pro.canonical, error: 'quality_gate_max_tokens', actual_cost_known: true },
      { provider: sonnet.provider, model: sonnet.canonical, error: 'quality_gate_max_tokens', actual_cost_known: true },
    ],
  }));

  // 5. Oversized system prompt drives token-hygiene findings.
  scenarioRows.push(row({
    id: 'req_demo_scenario_oversized_system_prompt',
    timestamp: at(1),
    session_id: 'sess_demo_scenario_oversized_system_prompt',
    provider: sonnet.provider,
    model_requested: sonnet.canonical,
    model_resolved: sonnet.canonical,
    input_tokens: 18_000,
    output_tokens: 2_000,
    system_prompt_tokens: 12_500,
    original_cost_microcents: costMicrocents(sonnet, 18_000, 2_000),
    actual_cost_microcents: costMicrocents(sonnet, 18_000, 2_000),
    activity_category: 'refactoring',
  }));

  // 6. Duplicate uncached requests exercise duplicate-waste detection.
  for (let i = 0; i < 2; i++) {
    scenarioRows.push(row({
      id: `req_demo_scenario_duplicate_uncached_${i}`,
      timestamp: at(1, 16 + i),
      session_id: 'sess_demo_scenario_duplicate_uncached',
      provider: sonnet.provider,
      model_requested: sonnet.canonical,
      model_resolved: sonnet.canonical,
      input_tokens: 24_000,
      output_tokens: 3_000,
      original_cost_microcents: costMicrocents(sonnet, 24_000, 3_000),
      actual_cost_microcents: costMicrocents(sonnet, 24_000, 3_000),
      cache_hit: false,
      message_hash: 'demohash_scenario_duplicate_uncached',
    }));
  }

  requestLogs.push(...scenarioRows);
  const bySession = new Map<string, RequestLogRow[]>();
  for (const scenarioRow of scenarioRows) {
    bySession.set(scenarioRow.session_id, [...(bySession.get(scenarioRow.session_id) ?? []), scenarioRow]);
  }
  for (const [sessionId, rows] of bySession.entries()) {
    addScenarioSession(sessions, rows.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()), sessionId, rows[0]!.model_resolved);
  }
}

interface Persona {
  kind: 'heavy' | 'moderate' | 'light';
  /** Inclusive monthly ACTUAL-spend target band, USD. */
  spendUsd: [number, number];
  /** Tier mix [cheap, mid, premium]. */
  weights: [number, number, number];
  /** input/output token bands passed to tokenAmount(rng, min, spread). */
  inputTok: [number, number];
  outputTok: [number, number];
  /** Max requests-per-session scale (low-biased). */
  reqScale: number;
  /**
   * Upper bound on sessions/user over the window. Generation stops at the
   * dollar target OR this cap, whichever comes first. The cap keeps the
   * dataset at a realistic, insertable volume — without it, cheap-tier light
   * users emit hundreds of thousands of sub-cent requests to reach their
   * dollar target, which is neither realistic nor practical to seed.
   */
  maxSessions: number;
}

const PERSONAS = {
  heavy: {
    kind: 'heavy',
    spendUsd: [5_000, 12_000],
    weights: [0.15, 0.45, 0.4],
    inputTok: [2_000, 60_000],
    outputTok: [200, 12_000],
    // Long agentic sessions (mean ~46 turns) — a real Claude-Code-style
    // session is dozens of large-context requests, which is what makes a
    // heavy user's monthly spend land in the $5k–12k band. maxSessions is a
    // generous runaway guard; the dollar target is the real stop here.
    reqScale: 180,
    maxSessions: 2_000,
  },
  moderate: {
    kind: 'moderate',
    spendUsd: [1_000, 3_000],
    weights: [0.3, 0.55, 0.15],
    inputTok: [800, 40_000],
    outputTok: [80, 8_000],
    reqScale: 90,
    maxSessions: 2_000,
  },
  light: {
    kind: 'light',
    spendUsd: [150, 900],
    weights: [0.72, 0.26, 0.02],
    inputTok: [200, 8_000],
    outputTok: [40, 1_500],
    // Light/workflow users run cheap-tier models on small payloads, so each
    // request costs a fraction of a cent. Reaching the nominal dollar band
    // would take hundreds of thousands of requests (unrealistic + impractical
    // to seed), so for this tier the session cap is the real stop — these
    // users realistically land below the band, which is itself a true signal.
    reqScale: 24,
    maxSessions: 500,
  },
} satisfies Record<string, Persona>;

// 25-user hero plan: 10 heavy agentic, 6 moderate, 9 light/workflow.
const HERO_PERSONA_PLAN: Persona['kind'][] = [
  ...Array<Persona['kind']>(10).fill('heavy'),
  ...Array<Persona['kind']>(6).fill('moderate'),
  ...Array<Persona['kind']>(9).fill('light'),
];

interface ProfileConfig {
  userKinds: Persona['kind'][];
  maxSessionsByKind: Record<Persona['kind'], number>;
  reqScaleMultiplier: number;
  spendMultiplier: number;
}

const PROFILE_CONFIGS: Record<DemoSeedProfile, ProfileConfig> = {
  // Safe for local/prod seed smoke: ~2k request_logs, 5 users, all core charts populated.
  small: {
    userKinds: ['heavy', 'moderate', 'moderate', 'light', 'light'],
    maxSessionsByKind: { heavy: 24, moderate: 22, light: 16 },
    reqScaleMultiplier: 0.45,
    spendMultiplier: 0.025,
  },
  // Default dashboard demo: rich enough for trends, bounded enough for small Railway DB volumes.
  standard: {
    userKinds: HERO_PERSONA_PLAN,
    maxSessionsByKind: { heavy: 72, moderate: 54, light: 28 },
    reqScaleMultiplier: 0.55,
    spendMultiplier: 0.08,
  },
  // Back-compat/high-volume benchmark profile. Use only when the DB has enough storage.
  hero: {
    userKinds: HERO_PERSONA_PLAN,
    maxSessionsByKind: { heavy: PERSONAS.heavy.maxSessions, moderate: PERSONAS.moderate.maxSessions, light: PERSONAS.light.maxSessions },
    reqScaleMultiplier: 1,
    spendMultiplier: 1,
  },
};

export function normalizeDemoSeedProfile(value: string | null | undefined): DemoSeedProfile {
  if (value === 'small' || value === 'standard' || value === 'hero') return value;
  return 'standard';
}

const FIRST_NAMES = [
  'Ava', 'Liam', 'Maya', 'Noah', 'Priya', 'Diego', 'Sofia', 'Omar', 'Hana', 'Lucas',
  'Zara', 'Ethan', 'Nina', 'Theo', 'Iris', 'Kai', 'Lena', 'Sam', 'Ruth', 'Jonah',
  'Mira', 'Felix', 'Yara', 'Owen', 'Tara',
];
const LAST_NAMES = [
  'Chen', 'Patel', 'Rossi', 'Khan', 'Nguyen', 'Garcia', 'Park', 'Silva', 'Cohen', 'Mori',
  'Adler', 'Reyes', 'Haas', 'Okafor', 'Lindqvist', 'Vega', 'Sato', 'Brandt', 'Costa', 'Ivanov',
  'Mensah', 'Bauer', 'Dubois', 'Flores', 'Novak',
];

function uniformUsd(rng: () => number, band: [number, number]): number {
  return band[0] + rng() * (band[1] - band[0]);
}

interface SeededUser {
  user: UserRow;
  member: TeamMemberRow;
  persona: Persona;
  keys: ApiKeyRow[];
  targetMicrocents: number;
}

export function generateDemoDataset(opts: GenerateOptions): DemoDataset {
  const now = opts.now;
  const rollingDays = opts.days ?? 30;
  const rng = makeRng(opts.seed ?? 0x5eed);
  const pool = buildModelPool();
  const dayMs = 24 * 60 * 60 * 1000;
  const windowStart = opts.includePreviousMonth
    ? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1)
    : now - rollingDays * dayMs;
  const days = Math.max(1, Math.ceil((now - windowStart) / dayMs));

  // Weight each day in the window by its weekday so weekdays are busier than
  // weekends — without dropping sessions (which would undershoot the target).
  const dayWeights = Array.from(
    { length: days },
    (_, d) => WEEKDAY_WEIGHTS[new Date(now - d * dayMs).getUTCDay()]!,
  );

  // ── Legacy single-pool path: a flat request-count target with the old
  //    0.3/0.55/0.15 tier mix and one shared keyset. Kept so existing callers
  //    (and the determinism unit test) still get a stable, fast dataset. ──
  if (opts.targetRequests != null) {
    return generateLegacyDataset(opts, { rng, pool, dayWeights, windowStart, days });
  }

  // ── Persona spectrum: profile-sized users across heavy / moderate / light tiers. ──
  const users: UserRow[] = [];
  const teamMembers: TeamMemberRow[] = [];
  const apiKeys: ApiKeyRow[] = [];
  const requestLogs: RequestLogRow[] = [];
  const sessions: SessionMetricRow[] = [];

  const profile = normalizeDemoSeedProfile(opts.profile);
  const profileConfig = PROFILE_CONFIGS[profile];

  const seeded: SeededUser[] = profileConfig.userKinds.map((kind, i) => {
    const basePersona = PERSONAS[kind];
    const persona: Persona = {
      ...basePersona,
      reqScale: Math.max(4, Math.round(basePersona.reqScale * profileConfig.reqScaleMultiplier)),
      maxSessions: profileConfig.maxSessionsByKind[kind],
    };
    const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
    const last = LAST_NAMES[i % LAST_NAMES.length]!;
    const name = `${first} ${last}`;

    const id = stableDemoUserId(i);
    const email =
      i === 0
        ? DEMO_USER_EMAIL
        : `${first.toLowerCase()}.${last.toLowerCase()}${i}@routeshift.local`;
    // user[0] is owner; the next two are admins; the rest members.
    const role = i === 0 ? 'owner' : i <= 2 ? 'admin' : 'member';

    const user: UserRow = { id, email, name, password_hash: 'demo-login-disabled' };
    const member: TeamMemberRow = { user_id: id, team_id: DEMO_TEAM_ID, role };

    // Heavy users carry two keys (Production + Staging); everyone else one.
    const keyDefs =
      persona.kind === 'heavy'
        ? [
            { suffix: 'prod', name: 'Production', env: 'live' },
            { suffix: 'staging', name: 'Staging', env: 'test' },
          ]
        : [{ suffix: 'prod', name: 'Production', env: 'live' }];

    const keys: ApiKeyRow[] = keyDefs.map((k, ki) => ({
      id: `key_demo_u${i}_${k.suffix}`,
      team_id: DEMO_TEAM_ID,
      key_hash: `demo-hash-u${i}-${k.suffix}-${(rng() * 1e9).toFixed(0)}`,
      key_prefix: `rs_${k.env}_u${i}${ki}${Math.floor(rng() * 9000 + 1000)}`,
      name: k.name,
      environment: k.env,
      created_at: new Date(windowStart - 7 * 24 * 60 * 60 * 1000),
      last_used: new Date(now - Math.floor(rng() * 6 * 60 * 60 * 1000)),
    }));

    const targetMicrocents = Math.round(
      uniformUsd(rng, persona.spendUsd) * profileConfig.spendMultiplier * MICROCENTS_PER_USD,
    );

    return { user, member, persona, keys, targetMicrocents };
  });

  for (const su of seeded) {
    users.push(su.user);
    teamMembers.push(su.member);
    apiKeys.push(...su.keys);
  }

  let userIndex = 0;
  for (const su of seeded) {
    const persona = su.persona;
    const pickModel = makeTieredModelPicker(pool, persona.weights);
    let userActual = 0;
    let sessionSeq = 0;

    for (let s = 0; s < persona.maxSessions; s++) {
      const dayOffset = weightedIndex(rng, dayWeights);
      const dayStart = now - dayOffset * 24 * 60 * 60 * 1000;
      const hour = weightedIndex(rng, HOUR_WEIGHTS);
      const sessionStart =
        dayStart -
        (new Date(dayStart).getUTCHours() - hour) * 60 * 60 * 1000 -
        Math.floor(rng() * 60 * 60 * 1000);
      const start = Math.min(now - 60_000, Math.max(windowStart, sessionStart));

      const sessionId = `sess_demo_u${userIndex}_${sessionSeq}`;
      const apiKey = pick(rng, su.keys);
      const sessionPick = pickModel(rng);
      const sessionModel = sessionPick.model;
      const reqCount = Math.max(
        1,
        Math.round(1 + rng() * rng() * persona.reqScale),
      );

      let cursor = start;
      let editTurns = 0;
      let retryTurns = 0;
      let sessionCost = 0;
      let firstAt = new Date(cursor);
      let lastAt = new Date(cursor);

      for (let r = 0; r < reqCount; r++) {
        cursor += Math.floor(2000 + rng() * 180_000); // 2s..3m apart
        if (cursor >= now) break;
        const ts = new Date(cursor);

        const reqPick = rng() < 0.8 ? sessionPick : pickModel(rng);
        const requested = reqPick.model;
        const requestedTier = reqPick.tier;

        const inputTokens = tokenAmount(rng, persona.inputTok[0], persona.inputTok[1]);
        const outputTokens = tokenAmount(rng, persona.outputTok[0], persona.outputTok[1]);
        const totalTokens = inputTokens + outputTokens;
        const systemPromptTokens = Math.min(
          inputTokens,
          Math.round(inputTokens * (0.08 + rng() * 0.3)),
        );

        const original = costMicrocents(requested, inputTokens, outputTokens);

        // SAVINGS STORY: expensive premium-tier requests get routed down to
        // a cheaper model far more often (~0.35) than baseline (~0.15), so
        // "savings by model substitution" dominates the savings view. We still
        // compare REAL per-request cost so savings >= 0.
        const routeDownProb = requestedTier === 'premium' ? 0.35 : 0.15;
        let resolvedModel = requested;
        let routedActual = original;
        if (rng() < routeDownProb) {
          const candidate = cheaperModel(rng, pool, requested);
          if (candidate) {
            const candidateCost = costMicrocents(candidate, inputTokens, outputTokens);
            if (candidateCost < original) {
              resolvedModel = candidate;
              routedActual = candidateCost;
            }
          }
        }
        const routed = resolvedModel !== requested;

        const cacheHit = rng() < 0.12;
        const actual = cacheHit ? 0 : routedActual;
        const savings = original - actual; // actual <= original by construction

        const roll = rng();
        let status = 200;
        let errorType: string | null = null;
        if (roll > 0.985) {
          status = 429;
          errorType = 'rate_limit_error';
        } else if (roll > 0.97) {
          status = pick(rng, [500, 502, 400]);
          errorType = pick(rng, ERROR_TYPES);
        }
        const rateLimited = status === 429 || rng() < 0.02;
        const isFallback = routed && rng() < 0.3;
        const { latency, ttft, isStreaming } = latencyForRequest({
          rng,
          tier: requestedTier,
          outputTokens,
          cacheHit,
          isFallback,
          status,
        });

        const category = rng() < 0.1 ? null : pick(rng, ACTIVITY_CATEGORIES);
        const edited =
          category === 'coding' || category === 'feature_dev' || category === 'refactoring';
        if (edited) editTurns++;
        const isRetry = edited && rng() < 0.25;
        if (isRetry) retryTurns++;

        // Repeat a stable message_hash within a session occasionally to exercise
        // the duplicate-request signal; otherwise unique-ish per request.
        const messageHash =
          rng() < 0.15
            ? `demohash_u${userIndex}_${sessionId.slice(-4)}`
            : `demohash_u${userIndex}_${sessionSeq}_${r}`;

        if (!cacheHit) sessionCost += actual;

        requestLogs.push({
          id: `req_demo_u${userIndex}_${sessionSeq}_${r}`,
          timestamp: ts,
          team_id: DEMO_TEAM_ID,
          provider: resolvedModel.provider,
          model_requested: requested.canonical,
          model_resolved: resolvedModel.canonical,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
          system_prompt_tokens: systemPromptTokens,
          original_cost_microcents: original,
          actual_cost_microcents: actual,
          savings_microcents: savings,
          total_latency_ms: latency,
          ttft_ms: ttft,
          is_streaming: isStreaming,
          is_fallback: isFallback,
          status_code: status,
          error_type: errorType,
          cache_hit: cacheHit,
          rate_limited: rateLimited,
          activity_category: category,
          session_id: sessionId,
          api_key_id: apiKey.id,
          message_hash: messageHash,
          edited_paths: edited ? [`src/file_${r}.ts`] : null,
          had_bash: rng() < 0.3,
        });

        if (r === 0) firstAt = ts;
        lastAt = ts;
      }

      sessions.push({
        session_id: sessionId,
        team_id: DEMO_TEAM_ID,
        edit_turns: editTurns,
        retry_turns: retryTurns,
        one_shot_rate:
          editTurns > 0
            ? Math.round(((editTurns - retryTurns) / editTurns) * 10000) / 10000
            : null,
        primary_model: sessionModel.canonical,
        total_cost_microcents: sessionCost,
        billed_cost_microcents: sessionCost,
        first_request_at: firstAt,
        last_request_at: lastAt,
      });

      userActual += sessionCost;
      sessionSeq++;
      if (userActual >= su.targetMicrocents) break;
    }

    userIndex++;
  }

  addNarrativeScenarioRows({ requestLogs, sessions, apiKeys, pool, now, windowStart });

  return { users, teamMembers, apiKeys, requestLogs, sessions };
}

/**
 * Legacy single-pool generator (fixed request count or single dollar target,
 * one shared keyset, no per-user personas). Preserved for back-compat callers
 * and the deterministic unit test that pins `targetRequests`.
 */
function generateLegacyDataset(
  opts: GenerateOptions,
  ctx: {
    rng: () => number;
    pool: DemoModel[];
    dayWeights: number[];
    windowStart: number;
    days: number;
  },
): DemoDataset {
  const now = opts.now;
  const { rng, pool, dayWeights, windowStart } = ctx;
  const target = opts.targetRequests ?? 4000;
  const targetSpendMicrocents =
    opts.targetSpendUsd != null ? Math.round(opts.targetSpendUsd * MICROCENTS_PER_USD) : null;
  const pickModel = makeTieredModelPicker(pool, [0.3, 0.55, 0.15]);

  const users: UserRow[] = [
    { id: DEMO_USER_ID, email: DEMO_USER_EMAIL, name: 'Demo User', password_hash: 'demo-login-disabled' },
  ];
  const teamMembers: TeamMemberRow[] = [
    { user_id: DEMO_USER_ID, team_id: DEMO_TEAM_ID, role: 'owner' },
  ];

  const apiKeys: ApiKeyRow[] = [
    { suffix: 'prod', name: 'Production', env: 'live' },
    { suffix: 'staging', name: 'Staging', env: 'test' },
    { suffix: 'ci', name: 'CI', env: 'test' },
  ].map((k, i) => ({
    id: `key_demo_${k.suffix}`,
    team_id: DEMO_TEAM_ID,
    key_hash: `demo-hash-${k.suffix}-${(rng() * 1e9).toFixed(0)}`,
    key_prefix: `rs_${k.env}_demo${i}${Math.floor(rng() * 9000 + 1000)}`,
    name: k.name,
    environment: k.env,
    created_at: new Date(windowStart - 7 * 24 * 60 * 60 * 1000),
    last_used: new Date(now - Math.floor(rng() * 6 * 60 * 60 * 1000)),
  }));

  const requestLogs: RequestLogRow[] = [];
  const sessions: SessionMetricRow[] = [];

  const avgPerSession = 12;
  const HARD_SESSION_CAP = 1_000_000;
  const sessionCount =
    targetSpendMicrocents != null
      ? HARD_SESSION_CAP
      : Math.max(1, Math.round(target / avgPerSession));
  let totalActualMicrocents = 0;

  for (let s = 0; s < sessionCount; s++) {
    const dayOffset = weightedIndex(rng, dayWeights);
    const dayStart = now - dayOffset * 24 * 60 * 60 * 1000;
    const hour = weightedIndex(rng, HOUR_WEIGHTS);
    const sessionStart =
      dayStart -
      (new Date(dayStart).getUTCHours() - hour) * 60 * 60 * 1000 -
      Math.floor(rng() * 60 * 60 * 1000);
    const start = Math.min(now - 60_000, Math.max(windowStart, sessionStart));

    const sessionId = `sess_demo_${s}`;
    const apiKey = pick(rng, apiKeys);
    const sessionPick = pickModel(rng);
    const sessionModel = sessionPick.model;
    const reqCount = Math.max(1, Math.round(2 + rng() * rng() * 28));

    let cursor = start;
    let editTurns = 0;
    let retryTurns = 0;
    let sessionCost = 0;
    let firstAt = new Date(cursor);
    let lastAt = new Date(cursor);

    for (let r = 0; r < reqCount; r++) {
      cursor += Math.floor(2000 + rng() * 180_000);
      if (cursor >= now) break;
      const ts = new Date(cursor);

      const reqPick = rng() < 0.8 ? sessionPick : pickModel(rng);
      const requested = reqPick.model;
      const requestedTier = reqPick.tier;

      const inputTokens = tokenAmount(rng, 800, 45_000);
      const outputTokens = tokenAmount(rng, 80, 8_000);
      const totalTokens = inputTokens + outputTokens;
      const systemPromptTokens = Math.min(
        inputTokens,
        Math.round(inputTokens * (0.08 + rng() * 0.3)),
      );

      const original = costMicrocents(requested, inputTokens, outputTokens);

      let resolvedModel = requested;
      let routedActual = original;
      if (rng() < 0.15) {
        const candidate = cheaperModel(rng, pool, requested);
        if (candidate) {
          const candidateCost = costMicrocents(candidate, inputTokens, outputTokens);
          if (candidateCost < original) {
            resolvedModel = candidate;
            routedActual = candidateCost;
          }
        }
      }
      const routed = resolvedModel !== requested;

      const cacheHit = rng() < 0.12;
      const actual = cacheHit ? 0 : routedActual;
      const savings = original - actual;

      const roll = rng();
      let status = 200;
      let errorType: string | null = null;
      if (roll > 0.985) {
        status = 429;
        errorType = 'rate_limit_error';
      } else if (roll > 0.97) {
        status = pick(rng, [500, 502, 400]);
        errorType = pick(rng, ERROR_TYPES);
      }
      const rateLimited = status === 429 || rng() < 0.02;
      const isFallback = routed && rng() < 0.3;
      const { latency, ttft, isStreaming } = latencyForRequest({
        rng,
        tier: requestedTier,
        outputTokens,
        cacheHit,
        isFallback,
        status,
      });

      const category = rng() < 0.1 ? null : pick(rng, ACTIVITY_CATEGORIES);
      const edited =
        category === 'coding' || category === 'feature_dev' || category === 'refactoring';
      if (edited) editTurns++;
      const isRetry = edited && rng() < 0.25;
      if (isRetry) retryTurns++;

      const messageHash = rng() < 0.15 ? `demohash${sessionId.slice(-4)}` : `demohash${s}_${r}`;

      if (!cacheHit) sessionCost += actual;

      requestLogs.push({
        id: `req_demo_${s}_${r}`,
        timestamp: ts,
        team_id: DEMO_TEAM_ID,
        provider: resolvedModel.provider,
        model_requested: requested.canonical,
        model_resolved: resolvedModel.canonical,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        system_prompt_tokens: systemPromptTokens,
        original_cost_microcents: original,
        actual_cost_microcents: actual,
        savings_microcents: savings,
        total_latency_ms: latency,
        ttft_ms: ttft,
        is_streaming: isStreaming,
        is_fallback: isFallback,
        status_code: status,
        error_type: errorType,
        cache_hit: cacheHit,
        rate_limited: rateLimited,
        activity_category: category,
        session_id: sessionId,
        api_key_id: apiKey.id,
        message_hash: messageHash,
        edited_paths: edited ? [`src/file_${r}.ts`] : null,
        had_bash: rng() < 0.3,
      });

      if (r === 0) firstAt = ts;
      lastAt = ts;
    }

    sessions.push({
      session_id: sessionId,
      team_id: DEMO_TEAM_ID,
      edit_turns: editTurns,
      retry_turns: retryTurns,
      one_shot_rate:
        editTurns > 0 ? Math.round(((editTurns - retryTurns) / editTurns) * 10000) / 10000 : null,
      primary_model: sessionModel.canonical,
      total_cost_microcents: sessionCost,
      billed_cost_microcents: sessionCost,
      first_request_at: firstAt,
      last_request_at: lastAt,
    });

    totalActualMicrocents += sessionCost;
    if (targetSpendMicrocents != null && totalActualMicrocents >= targetSpendMicrocents) break;
  }

  return { users, teamMembers, apiKeys, requestLogs, sessions };
}
