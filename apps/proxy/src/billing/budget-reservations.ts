/**
 * RSH-138 transactional budget reservation ledger.
 *
 * One Postgres transaction per lifecycle operation. Every operation locks
 * period rows first (team scope before key scope; within a scope daily ->
 * weekly -> monthly), then reservation rows for the request in period_id
 * order. Clocks are split: transaction_timestamp() derives UTC period keys
 * and duplicate detection; clock_timestamp() (statement time) drives every
 * lease-expiry comparison.
 *
 * Money is integer microcents end to end. Every decoded BIGINT aggregate and
 * every arithmetic result passes Number.isSafeInteger; an out-of-range
 * persisted value fails closed with an operator-visible error. Cap columns
 * (numeric USD) decode through the shared exact decimal parser — never a
 * binary-float multiplication.
 */

import type { PoolClient } from 'pg';

import { getPool } from '../db/pool.js';
import { config } from '../config.js';
import {
  buildBudgetReport,
  getBudgetWindows,
  parseUsdCap,
  retryAfterSeconds,
  type BudgetAction,
  type BudgetWindowKind,
} from '@routeshift/shared';
import type { BudgetEstimate } from './budget-estimate.js';
import { CHUNK_TIMEOUT_MS, CREDIT_RESERVATION_HEARTBEAT_MIN_INTERVAL_MS, DRAIN_TIMEOUT_MS } from '../streaming/relay.js';

export type BudgetReservationReasonCode =
  | 'no_dispatch'
  | 'plugin_only_failure'
  | 'cache_hit'
  | 'pre_dispatch_build'
  | 'adjustment_reject'
  | 'concurrent'
  | 'upstream_unknown'
  | 'stream_heartbeat_failure'
  | 'lease_reclaimed'
  | 'service_failure';

export interface BudgetReservation {
  requestId: string;
  teamId: string;
  apiKeyId: string | null;
  /** RSH-140: identity scope (layer_identity_id) when the key carries one. */
  identityId: string | null;
  estimatedMicrocents: number;
  reservedMicrocents: number;
  dispatched: boolean;
  terminal: boolean;
}

export interface BudgetReportWindowLine {
  kind: BudgetWindowKind;
  capMicrocents: number | null;
  actualMicrocents: number;
  reservedMicrocents: number;
  unknownHeldMicrocents: number;
  committedMicrocents: number;
  unknownCostRequests: number;
  action: Exclude<BudgetAction, 'ok'> | null;
  status: BudgetAction;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
}

export interface BudgetReport {
  windows: BudgetReportWindowLine[];
  actualCostsQualified: boolean;
}

export type BudgetAdmissionResult =
  | { allowed: true; reservation: BudgetReservation; warnings: string[] }
  | {
      allowed: false;
      kind: 'exceeded' | 'estimate_unavailable' | 'service_unavailable';
      statusCode: 402 | 429 | 503;
      scope: 'team' | 'identity' | 'key' | null;
      action: BudgetAction | null;
      window: BudgetWindowKind | null;
      resetAt: string | null;
      retryAfterSeconds: number | null;
      message: string;
    };

export interface BudgetReportInput {
  teamId: string;
  apiKeyId: string | null;
  /** RSH-140: per-identity scope (layer_identity_id of the calling key). */
  identityId?: string | null;
  /** Database-clock timestamp; defaults to transaction_timestamp() on the live pool. */
  now?: Date;
}

interface PeriodRow {
  id: string;
  team_id: string;
  api_key_id: string | null;
  identity_id: string | null;
  window_kind: BudgetWindowKind;
  period_start: Date;
  period_end: Date;
  reserved_microcents: string;
  unknown_held_microcents: string;
  actual_microcents: string;
  unknown_cost_requests: string;
  seeded_through: Date | null;
}

interface ReservationRow {
  id: string;
  period_id: string;
  request_id: string;
  team_id: string;
  api_key_id: string | null;
  identity_id: string | null;
  estimated_microcents: string;
  actual_microcents: string;
  unknown_held_microcents: string;
  known_lower_bound_microcents: string | null;
  estimate_unavailable: boolean;
  status: 'pending' | 'settled' | 'released' | 'unknown_held';
  lease_expires_at: Date;
  dispatched_at: Date | null;
}

interface CapRow {
  daily_usd_cap: string | null;
  weekly_usd_cap: string | null;
  monthly_usd_cap: string | null;
  hardAction: Exclude<BudgetAction, 'ok'>;
  alertAtPct: number | null;
}

interface ScopeCaps {
  scope: 'team' | 'identity' | 'key';
  teamId: string;
  apiKeyId: string | null;
  /** RSH-140: layer_identity_id for identity-scope rows. */
  identityId: string | null;
  caps: Partial<Record<BudgetWindowKind, number>>;
  hardAction: Exclude<BudgetAction, 'ok'>;
  alertAtPct: number | null;
}

const HARD_ACTIONS: ReadonlySet<string> = new Set(['throttle', 'block']);
const WINDOW_ORDER: readonly BudgetWindowKind[] = ['daily', 'weekly', 'monthly'];

/** Minimum lease the admission path must cover (plugin fetch + stream window
 * + drain + the relay's 5-minute stream heartbeat + margin). A lease below the
 * heartbeat would expire mid-stream before the first refresh. */
function minimumLeaseMs(): number {
  return config.pluginFetchTimeoutMs + CHUNK_TIMEOUT_MS + DRAIN_TIMEOUT_MS
    + CREDIT_RESERVATION_HEARTBEAT_MIN_INTERVAL_MS + 60_000;
}

function decodeMicrocents(value: string | number | null | undefined, column: string): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(
      `budget ledger has an out-of-range persisted microcent value in ${column}; refusing to admit`,
    );
  }
  return n;
}

function decodeCap(value: string | number | null | undefined, column: string): number | null {
  if (value == null) return null;
  const parsed = parseUsdCap(String(value));
  if (parsed == null) {
    throw new Error(`budget cap ${column} is not an exact 8-decimal decimal spelling; refusing to admit`);
  }
  return parsed.microcents;
}

function reservationFromRows(
  requestId: string,
  teamId: string,
  apiKeyId: string | null,
  identityId: string | null,
  rows: ReservationRow[],
  estimateMicrocents: number,
): BudgetReservation {
  return {
    requestId,
    teamId,
    apiKeyId,
    identityId,
    estimatedMicrocents: estimateMicrocents,
    reservedMicrocents: rows.reduce(
      (sum, r) => sum + (r.status === 'pending' ? decodeMicrocents(r.estimated_microcents, 'reservation.estimated_microcents') : 0),
      0,
    ),
    dispatched: rows.some((r) => r.dispatched_at != null),
    terminal: rows.some((r) => r.status !== 'pending'),
  };
}

function rejectExceeded(
  scope: 'team' | 'identity' | 'key',
  hardAction: Exclude<BudgetAction, 'ok'>,
  windowKind: BudgetWindowKind,
  resetAt: string,
  dbNow: Date,
  message: string,
): BudgetAdmissionResult {
  return {
    allowed: false,
    kind: 'exceeded',
    statusCode: hardAction === 'block' ? 402 : 429,
    scope,
    action: hardAction,
    window: windowKind,
    resetAt,
    retryAfterSeconds: retryAfterSeconds(new Date(resetAt), dbNow),
    message,
  };
}

async function loadCapRows(client: PoolClient, teamId: string): Promise<CapRow> {
  const { rows } = await client.query<{
    daily_usd_cap: string | null;
    weekly_usd_cap: string | null;
    monthly_usd_cap: string | null;
    hard_cap_action: string;
    alert_at_pct: number | null;
  }>(
    `SELECT daily_usd_cap, weekly_usd_cap, monthly_usd_cap, hard_cap_action, alert_at_pct
       FROM team_budgets WHERE team_id::text = $1`,
    [teamId],
  );
  const row = rows[0];
  if (!row) {
    return { daily_usd_cap: null, weekly_usd_cap: null, monthly_usd_cap: null, hardAction: 'alert', alertAtPct: null };
  }
  return {
    daily_usd_cap: row.daily_usd_cap,
    weekly_usd_cap: row.weekly_usd_cap,
    monthly_usd_cap: row.monthly_usd_cap,
    hardAction: row.hard_cap_action as Exclude<BudgetAction, 'ok'>,
    alertAtPct: row.alert_at_pct,
  };
}

async function loadKeyCapRow(client: PoolClient, teamId: string, apiKeyId: string): Promise<CapRow | null> {
  const { rows } = await client.query<{
    daily_usd_cap: string | null;
    weekly_usd_cap: string | null;
    monthly_usd_cap: string | null;
    cap_action: string;
    soft_alert_at_pct: number | null;
  }>(
    `SELECT daily_usd_cap, weekly_usd_cap, monthly_usd_cap, cap_action, soft_alert_at_pct
       FROM api_keys WHERE id = $1 AND team_id = $2`,
    [apiKeyId, teamId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    daily_usd_cap: row.daily_usd_cap,
    weekly_usd_cap: row.weekly_usd_cap,
    monthly_usd_cap: row.monthly_usd_cap,
    hardAction: row.cap_action as Exclude<BudgetAction, 'ok'>,
    alertAtPct: row.soft_alert_at_pct,
  };
}

async function loadIdentityCapRow(client: PoolClient, teamId: string, identityId: string): Promise<CapRow | null> {
  const { rows } = await client.query<{
    daily_usd_cap: string | null;
    weekly_usd_cap: string | null;
    monthly_usd_cap: string | null;
    cap_action: string;
    soft_alert_at_pct: number | null;
  }>(
    `SELECT daily_usd_cap, weekly_usd_cap, monthly_usd_cap, cap_action, soft_alert_at_pct
       FROM identity_budget_caps WHERE team_id = $1 AND identity_id = $2`,
    [teamId, identityId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    daily_usd_cap: row.daily_usd_cap,
    weekly_usd_cap: row.weekly_usd_cap,
    monthly_usd_cap: row.monthly_usd_cap,
    hardAction: row.cap_action as Exclude<BudgetAction, 'ok'>,
    alertAtPct: row.soft_alert_at_pct,
  };
}

/** RSH-140 scope ordering: team < identity < key (a person's ceiling across
 *  their keys, then the key's own tighter ceiling). */
function buildScopes(
  teamCap: CapRow,
  identityCap: CapRow | null,
  keyCap: CapRow | null,
  teamId: string,
  apiKeyId: string | null,
  identityId: string | null,
): ScopeCaps[] {
  const scopes: ScopeCaps[] = [];
  const teamCaps: Partial<Record<BudgetWindowKind, number>> = {};
  for (const kind of WINDOW_ORDER) {
    const col = `${kind}_usd_cap` as 'daily_usd_cap' | 'weekly_usd_cap' | 'monthly_usd_cap';
    const v = decodeCap(teamCap[col], `team_budgets.${col}`);
    if (v != null) teamCaps[kind] = v;
  }
  if (Object.keys(teamCaps).length > 0) {
    scopes.push({ scope: 'team', teamId, apiKeyId: null, identityId: null, caps: teamCaps, hardAction: teamCap.hardAction, alertAtPct: teamCap.alertAtPct });
  }
  if (identityId && identityCap) {
    const identityCaps: Partial<Record<BudgetWindowKind, number>> = {};
    for (const kind of WINDOW_ORDER) {
      const col = `${kind}_usd_cap` as 'daily_usd_cap' | 'weekly_usd_cap' | 'monthly_usd_cap';
      const v = decodeCap(identityCap[col], `identity_budget_caps.${col}`);
      if (v != null) identityCaps[kind] = v;
    }
    if (Object.keys(identityCaps).length > 0) {
      scopes.push({ scope: 'identity', teamId, apiKeyId: null, identityId, caps: identityCaps, hardAction: identityCap.hardAction, alertAtPct: identityCap.alertAtPct });
    }
  }
  if (apiKeyId && keyCap) {
    const keyCaps: Partial<Record<BudgetWindowKind, number>> = {};
    for (const kind of WINDOW_ORDER) {
      const col = `${kind}_usd_cap` as 'daily_usd_cap' | 'weekly_usd_cap' | 'monthly_usd_cap';
      const v = decodeCap(keyCap[col], `api_keys.${col}`);
      if (v != null) keyCaps[kind] = v;
    }
    if (Object.keys(keyCaps).length > 0) {
      scopes.push({ scope: 'key', teamId, apiKeyId, identityId: null, caps: keyCaps, hardAction: keyCap.hardAction, alertAtPct: keyCap.alertAtPct });
    }
  }
  return scopes;
}

/** Insert-or-lock every period row a scope needs, in canonical order; returns locked rows keyed by kind. */
async function lockScopePeriods(
  client: PoolClient,
  scope: ScopeCaps,
  windows: Array<{ kind: BudgetWindowKind; periodStart: Date; periodEnd: Date }>,
  dbNow: Date,
): Promise<Map<BudgetWindowKind, PeriodRow>> {
  const locked = new Map<BudgetWindowKind, PeriodRow>();
  for (const window of windows) {
    const kind = window.kind;
    // Sweep the closed periods for this window FIRST, for EVERY kind — capped
    // or not: a request dispatched just before a UTC reset whose lease expires
    // after the reset would otherwise sit pending forever (no later admission
    // locks the closed period again), and a stranded pending
    // estimate_unavailable row in a window whose cap was REMOVED would
    // otherwise never be reclaimed while the unbounded gate keeps freezing the
    // scope. Locked here in the canonical (kind, period_start) order alongside
    // the current row, so the admission and resolve paths share one global
    // lock order and cannot deadlock across a reset boundary.
    const keyWhere = scope.apiKeyId
      ? 'AND p.api_key_id = $4 AND p.identity_id IS NULL'
      : scope.identityId
        ? 'AND p.api_key_id IS NULL AND p.identity_id = $4'
        : 'AND p.api_key_id IS NULL AND p.identity_id IS NULL';
    const sweepParams = (scope.apiKeyId ?? scope.identityId)
      ? [scope.teamId, kind, dbNow, scope.apiKeyId ?? scope.identityId]
      : [scope.teamId, kind, dbNow];
    const { rows: previousRows } = await client.query<PeriodRow>(
      `SELECT p.* FROM budget_period_usage p
        WHERE p.team_id = $1 ${keyWhere}
          AND p.window_kind = $2 AND p.period_end < $3
          AND EXISTS (SELECT 1 FROM budget_reservations r
                       WHERE r.period_id = p.id AND r.status = 'pending'
                         AND r.lease_expires_at <= clock_timestamp())
        ORDER BY p.period_start ASC
        FOR UPDATE OF p`,
      sweepParams,
    );
    for (const previous of previousRows) {
      await reclaimExpired(client, previous.id);
      // A reclaimed (released) request's log may land after the reset; seed
      // capped closed periods so the real spend is attributed to the period
      // it belongs to instead of vanishing between windows. Uncapped windows
      // are never seeded (seeding them could CREATE unbounded unknowns that
      // the gate would then act on).
      if (scope.caps[kind] != null) {
        await seedPeriod(client, scope, previous, previous.period_end);
      }
    }
    // Uncapped windows get no current-period work at all.
    if (scope.caps[kind] == null) continue;
    // RSH-140 id namespaces: identity rows use team::identity:kind:start
    // (distinct from legacy team::kind:start and team:key:kind:start ids —
    // legacy ids never carry a second colon in the scope section), team/key
    // rows keep the EXACT legacy format so existing period rows stay findable
    // (a format change would orphan live ledger rows on deploy).
    const id = scope.identityId
      ? `${scope.teamId}::${scope.identityId}:${kind}:${window.periodStart.toISOString()}`
      : `${scope.teamId}:${scope.apiKeyId ?? ''}:${kind}:${window.periodStart.toISOString()}`;
    await client.query(
      `INSERT INTO budget_period_usage (id, team_id, api_key_id, identity_id, window_kind, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, scope.teamId, scope.apiKeyId, scope.identityId, kind, window.periodStart, window.periodEnd],
    );
    const { rows } = await client.query<PeriodRow>(`SELECT * FROM budget_period_usage WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw new Error(`budget period row ${id} missing after upsert`);
    locked.set(kind, rows[0]);
  }
  return locked;
}

interface SeedResult {
  seededCount: number;
  newUnknownCount: number;
  newActualMicrocents: number;
}

/** Idempotent historical seeding from request_logs for one locked period row. */
async function seedPeriod(
  client: PoolClient,
  scope: ScopeCaps,
  period: PeriodRow,
  periodEnd: Date,
): Promise<SeedResult> {
  // The lookback must never reach before the period's own start: re-seeding
  // yesterday's rows into today's window would double-count spend at rollover.
  const rawLookback = period.seeded_through
    ? new Date(period.seeded_through.getTime() - 5 * 60 * 1000)
    : period.period_start;
  const lookback = new Date(Math.max(rawLookback.getTime(), period.period_start.getTime()));
  // Team scope counts ALL team request_logs (key-attributed or not); the key
  // scope filters to that key's rows. A single SQL shape with a nullable $3
  // keeps the parameter list valid for both scopes (a team-scope statement
  // that never referenced $3 failed Postgres parse with 5 bound params).
  const { rows } = await client.query<{
    seeded_count: string;
    new_unknown_count: string;
    new_actual: string;
  }>(
    `WITH newly AS (
       INSERT INTO budget_period_seeded_requests (period_id, request_id, actual_microcents, known_cost)
       SELECT $1, rl.id,
              rl.actual_cost_microcents + COALESCE(rl.plugin_cost_microcents, 0),
              COALESCE(rl.actual_cost_known, false)
         FROM request_logs rl
        WHERE rl.team_id = $2
          AND ($3::text IS NULL OR rl.api_key_id = $3)
          AND ($4::text IS NULL OR rl.layer_identity_id = $4)
          AND rl.timestamp >= $5 AND rl.timestamp < $6
          AND NOT EXISTS (SELECT 1 FROM budget_period_seeded_requests s
                           WHERE s.period_id = $1 AND s.request_id = rl.id)
          AND NOT EXISTS (SELECT 1 FROM budget_reservations r
                           WHERE r.period_id = $1 AND r.request_id = rl.id
                             AND r.status <> 'released')
          AND NOT EXISTS (SELECT 1 FROM pending_unknown_cost_holds h
                           WHERE h.team_id = rl.team_id AND h.request_id = rl.id
                             AND h.status IN ('reconciled', 'released'))
       ON CONFLICT (period_id, request_id) DO NOTHING
       RETURNING actual_microcents, known_cost
     ), watermark AS (
       SELECT MAX(rl.timestamp) AS max_ts
         FROM request_logs rl
        WHERE rl.team_id = $2
          AND ($3::text IS NULL OR rl.api_key_id = $3)
          AND ($4::text IS NULL OR rl.layer_identity_id = $4)
          AND rl.timestamp >= $5 AND rl.timestamp < $6
     )
     UPDATE budget_period_usage p SET
       seeded_through = GREATEST(p.seeded_through, wm.max_ts),
       seeded_request_count = p.seeded_request_count + (SELECT COUNT(*) FROM newly),
       actual_microcents = p.actual_microcents + (SELECT COALESCE(SUM(actual_microcents), 0) FROM newly),
       unknown_cost_requests = p.unknown_cost_requests + (SELECT COUNT(*) FILTER (WHERE NOT known_cost) FROM newly)
     FROM watermark wm
     WHERE p.id = $1
     RETURNING
       (SELECT COUNT(*) FROM newly) AS seeded_count,
       (SELECT COUNT(*) FILTER (WHERE NOT known_cost) FROM newly) AS new_unknown_count,
       (SELECT COALESCE(SUM(actual_microcents), 0) FROM newly) AS new_actual`,
    [period.id, scope.teamId, scope.apiKeyId ?? null, scope.identityId ?? null, lookback, periodEnd],
  );
  const row = rows[0];
  return {
    seededCount: Number(row?.seeded_count ?? 0),
    newUnknownCount: Number(row?.new_unknown_count ?? 0),
    newActualMicrocents: Number(row?.new_actual ?? 0),
  };
}

/** Reclaim expired pending leases on one locked period row; returns reserved released and converted-to-held. */
async function reclaimExpired(
  client: PoolClient,
  periodId: string,
): Promise<{ releasedMicrocents: number; convertedMicrocents: number }> {
  const { rows } = await client.query<{ released_amount: string; converted_amount: string }>(
    `WITH expired AS (
       SELECT id, estimated_microcents, dispatched_at
         FROM budget_reservations
        WHERE period_id = $1 AND status = 'pending' AND lease_expires_at <= clock_timestamp()
     ), released AS (
       UPDATE budget_reservations r SET status = 'released', settled_at = clock_timestamp()
         FROM expired e WHERE e.id = r.id AND e.dispatched_at IS NULL
         RETURNING r.estimated_microcents
     ), converted AS (
       UPDATE budget_reservations r SET status = 'unknown_held',
              unknown_held_microcents = r.estimated_microcents,
              known_lower_bound_microcents = 0,
              settled_at = clock_timestamp()
         FROM expired e WHERE e.id = r.id AND e.dispatched_at IS NOT NULL
         RETURNING r.estimated_microcents
     )
     UPDATE budget_period_usage p SET
       reserved_microcents = p.reserved_microcents
         - (SELECT COALESCE(SUM(estimated_microcents), 0) FROM released)
         - (SELECT COALESCE(SUM(estimated_microcents), 0) FROM converted),
       unknown_held_microcents = p.unknown_held_microcents
         + (SELECT COALESCE(SUM(estimated_microcents), 0) FROM converted),
       unknown_cost_requests = p.unknown_cost_requests
         + (SELECT COUNT(*) FROM converted)
     WHERE p.id = $1
     RETURNING
       (SELECT COALESCE(SUM(estimated_microcents), 0) FROM released) AS released_amount,
       (SELECT COALESCE(SUM(estimated_microcents), 0) FROM converted) AS converted_amount`,
    [periodId],
  );
  const row = rows[0];
  return {
    releasedMicrocents: Number(row?.released_amount ?? 0),
    convertedMicrocents: Number(row?.converted_amount ?? 0),
  };
}

/** Unbounded-unknown existence for a scope: unknown_held @ estimate 0, in-flight estimate_unavailable, or unresolved seed rows. */
async function scopeHasUnboundedUnknown(
  client: PoolClient,
  scope: ScopeCaps,
): Promise<boolean> {
  const keyPred = scope.apiKeyId
    ? 'AND p.api_key_id = $2 AND p.identity_id IS NULL'
    : scope.identityId
      ? 'AND p.api_key_id IS NULL AND p.identity_id = $2'
      : 'AND p.api_key_id IS NULL AND p.identity_id IS NULL';
  const params = (scope.apiKeyId ?? scope.identityId) ? [scope.teamId, scope.apiKeyId ?? scope.identityId] : [scope.teamId];
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM budget_reservations r JOIN budget_period_usage p ON p.id = r.period_id
        WHERE p.team_id = $1 ${keyPred}
          AND ((r.status = 'unknown_held' AND r.estimated_microcents = 0)
            OR (r.status = 'pending' AND r.estimate_unavailable = true))
       UNION ALL
       SELECT 1 FROM budget_period_seeded_requests s JOIN budget_period_usage p ON p.id = s.period_id
        WHERE p.team_id = $1 ${keyPred} AND s.known_cost = false
     ) AS exists`,
    params,
  );
  return rows[0]?.exists ?? false;
}

interface AdmissionPlan {
  scope: ScopeCaps;
  periods: Map<BudgetWindowKind, PeriodRow>;
}

export async function reserveBudget(input: {
  requestId: string;
  teamId: string;
  apiKeyId: string | null;
  /** RSH-140: layer_identity_id of the calling key (per-person ceiling). */
  identityId?: string | null;
  estimate: BudgetEstimate;
}): Promise<BudgetAdmissionResult> {
  if (config.budgetReservationLeaseMs < minimumLeaseMs()) {
    return {
      allowed: false,
      kind: 'service_unavailable',
      statusCode: 503,
      scope: null,
      action: null,
      window: null,
      resetAt: null,
      retryAfterSeconds: null,
      message: `BUDGET_RESERVATION_LEASE_MS ${config.budgetReservationLeaseMs} is below the required floor ${minimumLeaseMs()}`,
    };
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: clockRows } = await client.query<{ db_now: Date }>(
      'SELECT transaction_timestamp() AS db_now',
    );
    const dbNow = clockRows[0].db_now;
    const windows = getBudgetWindows(dbNow);

    const teamCap = await loadCapRows(client, input.teamId);
    const identityCap = input.identityId ? await loadIdentityCapRow(client, input.teamId, input.identityId) : null;
    const keyCap = input.apiKeyId ? await loadKeyCapRow(client, input.teamId, input.apiKeyId) : null;
    const scopes = buildScopes(teamCap, identityCap, keyCap, input.teamId, input.apiKeyId, input.identityId ?? null);
    if (scopes.length === 0) {
      // No caps configured for either scope: nothing to enforce or track.
      await client.query('COMMIT');
      return {
        allowed: true,
        reservation: {
          requestId: input.requestId,
          teamId: input.teamId,
          apiKeyId: input.apiKeyId,
          identityId: input.identityId ?? null,
          estimatedMicrocents: input.estimate.estimatedMicrocents ?? 0,
          reservedMicrocents: 0,
          dispatched: false,
          terminal: false,
        },
        warnings: ['no_budget_caps_configured'],
      };
    }

    // Duplicate detection happens before cap arithmetic and before any insert.
    const { rows: existingRows } = await client.query<ReservationRow>(
      `SELECT * FROM budget_reservations WHERE request_id = $1 AND team_id = $2 ORDER BY period_id`,
      [input.requestId, input.teamId],
    );
    if (existingRows.length > 0) {
      // Idempotent re-entry is only valid while every row is still pending (a
      // concurrent duplicate may have won the inserts). A terminal row means
      // this request_id already settled/released/held — admitting again would
      // dispatch UNRESERVED (the insert conflicts) and could repeat for free
      // against a hard cap. Fail closed instead.
      if (existingRows.some((r) => r.status !== 'pending')) {
        await client.query('ROLLBACK');
        return {
          allowed: false,
          kind: 'service_unavailable',
          statusCode: 503,
          scope: null,
          action: null,
          window: null,
          resetAt: null,
          retryAfterSeconds: null,
          message: 'Duplicate terminal budget reservation for this request',
        };
      }
      await client.query('COMMIT');
      return {
        allowed: true,
        reservation: reservationFromRows(
          input.requestId,
          input.teamId,
          input.apiKeyId,
          input.identityId ?? null,
          existingRows,
          input.estimate.estimatedMicrocents ?? 0,
        ),
        warnings: [],
      };
    }

    // Lock every applicable period row in canonical order (team scope first, then key scope).
    const plans: AdmissionPlan[] = [];
    for (const scope of scopes) {
      const periods = await lockScopePeriods(client, scope, windows, dbNow);
      plans.push({ scope, periods });
    }

    // Re-check for duplicates AFTER the period locks: the pre-lock duplicate
    // SELECT can miss a concurrent admission of the same request that commits
    // while we wait on the locks. Without this, the retry would then run the
    // cap check against a period that already counts its own reservation and
    // fail with a false 402/429.
    const { rows: postLockRows } = await client.query<ReservationRow>(
      `SELECT * FROM budget_reservations WHERE request_id = $1 AND team_id = $2 ORDER BY period_id`,
      [input.requestId, input.teamId],
    );
    if (postLockRows.length > 0) {
      if (postLockRows.some((r) => r.status !== 'pending')) {
        await client.query('ROLLBACK');
        return {
          allowed: false,
          kind: 'service_unavailable',
          statusCode: 503,
          scope: null,
          action: null,
          window: null,
          resetAt: null,
          retryAfterSeconds: null,
          message: 'Duplicate terminal budget reservation for this request',
        };
      }
      await client.query('COMMIT');
      return {
        allowed: true,
        reservation: reservationFromRows(
          input.requestId,
          input.teamId,
          input.apiKeyId,
          input.identityId ?? null,
          postLockRows,
          input.estimate.estimatedMicrocents ?? 0,
        ),
        warnings: [],
      };
    }

    // Idempotent seeding and lease reclamation, per locked period.
    for (const plan of plans) {
      for (const [kind, period] of plan.periods) {
        const window = windows.find((w) => w.kind === kind)!;
        await seedPeriod(client, plan.scope, period, window.periodEnd);
        await reclaimExpired(client, period.id);
      }
      // Seeding and reclamation mutate the locked rows; re-read the fresh
      // aggregates before any cap comparison (same transaction sees its own writes).
      for (const [kind] of plan.periods) {
        const window = windows.find((w) => w.kind === kind)!;
        const id = plan.scope.identityId
          ? `${plan.scope.teamId}::${plan.scope.identityId}:${kind}:${window.periodStart.toISOString()}`
          : `${plan.scope.teamId}:${plan.scope.apiKeyId ?? ''}:${kind}:${window.periodStart.toISOString()}`;
        const { rows: fresh } = await client.query<PeriodRow>(
          `SELECT * FROM budget_period_usage WHERE id = $1`,
          [id],
        );
        plan.periods.set(kind, fresh[0]);
      }
    }

    const warnings: string[] = [];
    const estimate = input.estimate.estimatedMicrocents;

    // Fail-closed estimate gate: null estimate (missing pricing) + any hard cap.
    if (estimate == null) {
      const hard = plans.find((plan) =>
        [...plan.periods.keys()].some((kind) => HARD_ACTIONS.has(plan.scope.hardAction)),
      );
      if (hard) {
        await client.query('ROLLBACK');
        const strictestKind = [...hard.periods.keys()].sort(
          (a, b) => windows.find((w) => w.kind === a)!.resetAt.localeCompare(windows.find((w) => w.kind === b)!.resetAt),
        )[0];
        return {
          allowed: false,
          kind: 'estimate_unavailable',
          statusCode: 503,
          scope: hard.scope.scope,
          action: hard.scope.hardAction,
          window: strictestKind,
          resetAt: windows.find((w) => w.kind === strictestKind)!.resetAt,
          retryAfterSeconds: retryAfterSeconds(
            new Date(windows.find((w) => w.kind === strictestKind)!.resetAt),
            dbNow,
          ),
          message: 'Estimated cost unavailable and a hard budget cap is active',
        };
      }
      warnings.push('unknown_pricing');
    }

    // Unbounded gate: hard cap + unresolved unbounded unknown row in the same scope.
    for (const plan of plans) {
      const hasHard = [...plan.periods.keys()].some((kind) => HARD_ACTIONS.has(plan.scope.hardAction));
      if (hasHard && (await scopeHasUnboundedUnknown(client, plan.scope))) {
        await client.query('ROLLBACK');
        const strictestKind = [...plan.periods.keys()].sort(
          (a, b) => windows.find((w) => w.kind === a)!.resetAt.localeCompare(windows.find((w) => w.kind === b)!.resetAt),
        )[0];
        return {
          allowed: false,
          kind: 'estimate_unavailable',
          statusCode: 503,
          scope: plan.scope.scope,
          action: plan.scope.hardAction,
          window: strictestKind,
          resetAt: windows.find((w) => w.kind === strictestKind)!.resetAt,
          retryAfterSeconds: retryAfterSeconds(
            new Date(windows.find((w) => w.kind === strictestKind)!.resetAt),
            dbNow,
          ),
          message: 'Unresolved unbounded unknown cost blocks hard-capped admission',
        };
      }
    }

    // Cap check: reject only when committed_before + estimate > cap (equality
    // admits) AND the scope's action is a hard action. Alert-only windows
    // never reject traffic — the alert status is reporting-only.
    if (estimate != null) {
      for (const plan of plans) {
        for (const [kind, period] of plan.periods) {
          const cap = plan.scope.caps[kind]!;
          const committedBefore =
            decodeMicrocents(period.actual_microcents, 'period.actual_microcents') +
            decodeMicrocents(period.unknown_held_microcents, 'period.unknown_held_microcents') +
            decodeMicrocents(period.reserved_microcents, 'period.reserved_microcents');
          if (committedBefore + estimate > cap && HARD_ACTIONS.has(plan.scope.hardAction)) {
            await client.query('ROLLBACK');
            const window = windows.find((w) => w.kind === kind)!;
            return rejectExceeded(
              plan.scope.scope,
              plan.scope.hardAction,
              kind,
              window.resetAt,
              dbNow,
              `Budget cap exceeded for ${kind} window`,
            );
          }
        }
      }
    }

    // Insert reservation rows; increment counters only for rows the insert returned.
    const estimateValue = estimate ?? 0;
    const reservedDelta = estimateValue;
    const leaseMs = config.budgetReservationLeaseMs;
    let insertedAny = false;
    for (const plan of plans) {
      for (const [, period] of plan.periods) {
        const id = `${period.id}:${input.requestId}`;
        const { rows: inserted } = await client.query<ReservationRow>(
          `INSERT INTO budget_reservations
             (id, period_id, request_id, team_id, api_key_id, identity_id, estimated_microcents,
              estimate_unavailable, status, lease_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending',
                   clock_timestamp() + make_interval(secs => $9))
           ON CONFLICT (period_id, request_id) DO NOTHING
           RETURNING *`,
          // scope-stamped: a team-period reservation carries NULL key/identity,
          // an identity-period carries the identity, a key-period the key —
          // the scope-match trigger requires the reservation to mirror its
          // period exactly (the request's key/identity is echoed separately)
          [id, period.id, input.requestId, input.teamId,
           plan.scope.apiKeyId, plan.scope.identityId,
           estimateValue, estimate == null, leaseMs / 1000],
        );
        if (inserted.length > 0) {
          insertedAny = true;
          await client.query(
            `UPDATE budget_period_usage SET reserved_microcents = reserved_microcents + $1, updated_at = now() WHERE id = $2`,
            [reservedDelta, period.id],
          );
        }
      }
    }

    // A concurrent duplicate may have won every insert; surface its state instead.
    const { rows: finalRows } = await client.query<ReservationRow>(
      `SELECT * FROM budget_reservations WHERE request_id = $1 AND team_id = $2 ORDER BY period_id`,
      [input.requestId, input.teamId],
    );
    if (!insertedAny && finalRows.length === 0) {
      await client.query('ROLLBACK');
      return {
        allowed: false,
        kind: 'service_unavailable',
        statusCode: 503,
        scope: null,
        action: null,
        window: null,
        resetAt: null,
        retryAfterSeconds: null,
        message: 'Budget reservation insert failed',
      };
    }

    await client.query('COMMIT');
    return {
      allowed: true,
      reservation: reservationFromRows(
        input.requestId,
        input.teamId,
        input.apiKeyId,
        input.identityId ?? null,
        finalRows,
        estimateValue,
      ),
      warnings,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // client already aborted the transaction
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lock the request's period rows first (team scope before key scope, daily ->
 * weekly -> monthly within a scope), then the request's reservation rows in
 * that same canonical order. All lifecycle transitions go through here so
 * every operation acquires locks in the identical global order.
 */
async function lockReservationRows(client: PoolClient, requestId: string, teamId: string): Promise<ReservationRow[]> {
  const WINDOW_RANK = `CASE p.window_kind WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END`;
  // 1) All period rows referenced by the request, canonical order. The team
  // predicate is an authorization fence: request ids must never let one team
  // lock or mutate another team's ledger rows.
  await client.query(
    `SELECT p.id FROM budget_period_usage p
       JOIN budget_reservations r ON r.period_id = p.id
      WHERE r.request_id = $1 AND r.team_id = $2
      ORDER BY (p.api_key_id IS NOT NULL), (p.identity_id IS NOT NULL), (p.identity_id IS NOT NULL), ${WINDOW_RANK}, p.period_start
      FOR UPDATE OF p`,
    [requestId, teamId],
  );
  // 2) The reservation rows themselves, same canonical order.
  const { rows } = await client.query<ReservationRow>(
    `SELECT r.* FROM budget_reservations r
       JOIN budget_period_usage p ON p.id = r.period_id
      WHERE r.request_id = $1 AND r.team_id = $2
      ORDER BY (r.api_key_id IS NOT NULL), (r.identity_id IS NOT NULL), (r.identity_id IS NOT NULL), ${WINDOW_RANK}, p.period_start
      FOR UPDATE OF r`,
    [requestId, teamId],
  );
  return rows;
}

export async function adjustBudgetReservation(input: {
  reservation: BudgetReservation;
  estimate: BudgetEstimate;
}): Promise<BudgetAdmissionResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: clockRows } = await client.query<{ db_now: Date }>(
      'SELECT transaction_timestamp() AS db_now',
    );
    const dbNow = clockRows[0].db_now;
    const windows = getBudgetWindows(dbNow);
    const rows = await lockReservationRows(client, input.reservation.requestId, input.reservation.teamId);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        allowed: false,
        kind: 'service_unavailable',
        statusCode: 503,
        scope: null,
        action: null,
        window: null,
        resetAt: null,
        retryAfterSeconds: null,
        message: 'Budget service unavailable',
      };
    }

    const newEstimate = input.estimate.estimatedMicrocents;
    if (newEstimate != null) {
      const delta = newEstimate - decodeMicrocents(rows[0].estimated_microcents, 'reservation.estimated_microcents');
      if (delta > 0) {
        const teamCap = await loadCapRows(client, input.reservation.teamId);
        const identityCap = input.reservation.identityId
          ? await loadIdentityCapRow(client, input.reservation.teamId, input.reservation.identityId)
          : null;
        const keyCap = input.reservation.apiKeyId
          ? await loadKeyCapRow(client, input.reservation.teamId, input.reservation.apiKeyId)
          : null;
        const scopes = buildScopes(teamCap, identityCap, keyCap, input.reservation.teamId, input.reservation.apiKeyId, input.reservation.identityId);
        // Fail-closed parity with admission: a scope frozen by an unresolved
        // unbounded unknown must not grow exposure through the adjustment path.
        for (const scope of scopes) {
          const hasHard = Object.keys(scope.caps).some((kind) => HARD_ACTIONS.has(scope.hardAction));
          if (hasHard && (await scopeHasUnboundedUnknown(client, scope))) {
            await client.query('ROLLBACK');
            const strictestKind = Object.keys(scope.caps).sort(
              (a, b) => windows.find((w) => w.kind === a)!.resetAt.localeCompare(windows.find((w) => w.kind === b)!.resetAt),
            )[0] as BudgetWindowKind;
            const window = windows.find((w) => w.kind === strictestKind)!;
            return {
              allowed: false,
              kind: 'estimate_unavailable',
              statusCode: 503,
              scope: scope.scope,
              action: scope.hardAction,
              window: strictestKind,
              resetAt: window.resetAt,
              retryAfterSeconds: retryAfterSeconds(new Date(window.resetAt), dbNow),
              message: 'Unresolved unbounded unknown cost blocks budget adjustment',
            };
          }
        }
        // Validate the delta against the reservation's OWN period rows (already
        // locked above) — the delta lands on those periods, not on whatever
        // window boundary is current now. Checking freshly-computed windows
        // could reject against a period the delta never touches (or admit
        // against a full one).
        const { rows: periodRows } = await client.query<PeriodRow & { api_key_id: string | null }>(
          `SELECT p.* FROM budget_period_usage p
             JOIN budget_reservations r ON r.period_id = p.id
            WHERE r.request_id = $1 AND r.team_id = $2
            ORDER BY (p.api_key_id IS NOT NULL), (p.identity_id IS NOT NULL),
              CASE p.window_kind WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END,
              p.period_start`,
          [input.reservation.requestId, input.reservation.teamId],
        );
        for (const scope of scopes) {
          for (const period of periodRows) {
            const scopeMatches = scope.apiKeyId
              ? period.api_key_id === scope.apiKeyId && period.identity_id == null
              : scope.identityId
                ? period.api_key_id == null && period.identity_id === scope.identityId
                : period.api_key_id == null && period.identity_id == null;
            if (!scopeMatches) continue;
            const cap = scope.caps[period.window_kind];
            if (cap == null) continue;
            const committedBefore =
              decodeMicrocents(period.actual_microcents, 'period.actual_microcents') +
              decodeMicrocents(period.unknown_held_microcents, 'period.unknown_held_microcents') +
              decodeMicrocents(period.reserved_microcents, 'period.reserved_microcents');
            if (committedBefore + delta > cap && HARD_ACTIONS.has(scope.hardAction)) {
              await client.query('ROLLBACK');
              return rejectExceeded(
                scope.scope,
                scope.hardAction,
                period.window_kind,
                period.period_end.toISOString(),
                dbNow,
                `Adjusted estimate exceeds budget cap for ${period.window_kind} window`,
              );
            }
          }
        }
      }
    }

    // Fenced atomic update with lease refresh; zero affected rows fails closed.
    const adjustedEstimate =
      newEstimate ?? decodeMicrocents(rows[0].estimated_microcents, 'reservation.estimated_microcents');
    const { rows: updatedRows } = await client.query<{ id: string; period_id: string }>(
      `UPDATE budget_reservations SET
         estimated_microcents = $1,
         lease_expires_at = clock_timestamp() + make_interval(secs => $2)
       WHERE request_id = $3 AND team_id = $4 AND status = 'pending'
         AND lease_expires_at > clock_timestamp()
       RETURNING id, period_id`,
      [adjustedEstimate, config.budgetReservationLeaseMs / 1000, input.reservation.requestId, input.reservation.teamId],
    );
    if (updatedRows.length === 0) {
      await client.query('ROLLBACK');
      return {
        allowed: false,
        kind: 'service_unavailable',
        statusCode: 503,
        scope: null,
        action: null,
        window: null,
        resetAt: null,
        retryAfterSeconds: null,
        message: 'Budget service unavailable',
      };
    }
    // Move the delta onto each live period's reserved aggregate (live rows only —
    // a reclaimed period's reserved was already released and must not be touched).
    for (const updated of updatedRows) {
      const old = rows.find((r) => r.id === updated.id);
      if (!old) continue;
      const oldEstimate = decodeMicrocents(old.estimated_microcents, 'reservation.estimated_microcents');
      const delta = adjustedEstimate - oldEstimate;
      if (delta !== 0) {
        await client.query(
          `UPDATE budget_period_usage SET reserved_microcents = reserved_microcents + $1, updated_at = now() WHERE id = $2`,
          [delta, updated.period_id],
        );
      }
    }

    const { rows: fresh } = await client.query<ReservationRow>(
      `SELECT r.* FROM budget_reservations r
         JOIN budget_period_usage p ON p.id = r.period_id
        WHERE r.request_id = $1 AND r.team_id = $2
        ORDER BY (r.api_key_id IS NOT NULL), (r.identity_id IS NOT NULL),
          CASE p.window_kind WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END, p.period_start`,
      [input.reservation.requestId, input.reservation.teamId],
    );
    await client.query('COMMIT');
    return {
      allowed: true,
      reservation: reservationFromRows(
        input.reservation.requestId,
        input.reservation.teamId,
        input.reservation.apiKeyId,
        input.reservation.identityId,
        fresh,
        adjustedEstimate,
      ),
      warnings: input.estimate.estimatedMicrocents == null ? ['unknown_pricing'] : [],
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // client already aborted the transaction
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function markBudgetReservationDispatched(
  reservation: BudgetReservation,
): Promise<{ marked: boolean; alreadyMarked: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `UPDATE budget_reservations SET
         dispatched_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => $1)
       WHERE request_id = $2 AND team_id = $3 AND status = 'pending'
         AND dispatched_at IS NULL AND lease_expires_at > clock_timestamp()
       RETURNING id`,
      [config.budgetReservationLeaseMs / 1000, reservation.requestId, reservation.teamId],
    );
    // Every pending row must be marked: a partial mark would dispatch while one
    // window's row is expired (reclaimable) and later silently skip that
    // window's settlement — real spend recorded in no period. A partial mark
    // ROLLS BACK so the handler's release path can free the untouched rows
    // (a committed partial mark would be unfreeable and idle into an
    // over-hold).
    const { rows: remaining } = await client.query<{ id: string }>(
      `SELECT id FROM budget_reservations
        WHERE request_id = $1 AND team_id = $2 AND status = 'pending' AND dispatched_at IS NULL`,
      [reservation.requestId, reservation.teamId],
    );
    if (rows.length > 0 && remaining.length === 0) {
      await client.query('COMMIT');
      return { marked: true, alreadyMarked: false };
    }
    await client.query('ROLLBACK');
    const { rows: check } = await client.query<{ dispatched_at: Date | null; status: string }>(
      `SELECT dispatched_at, status FROM budget_reservations WHERE request_id = $1 AND team_id = $2`,
      [reservation.requestId, reservation.teamId],
    );
    const dispatched = check.some((r) => r.dispatched_at != null && r.status === 'pending');
    return { marked: false, alreadyMarked: dispatched };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // client already aborted the transaction
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function refreshBudgetReservationLease(
  reservation: BudgetReservation,
): Promise<{ refreshed: boolean }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `UPDATE budget_reservations SET
         lease_expires_at = clock_timestamp() + make_interval(secs => $1)
       WHERE request_id = $2 AND team_id = $3 AND status = 'pending'
         AND lease_expires_at > clock_timestamp()
       RETURNING id`,
      [config.budgetReservationLeaseMs / 1000, reservation.requestId, reservation.teamId],
    );
    const { rows: remaining } = await client.query<{ id: string }>(
      `SELECT id FROM budget_reservations
        WHERE request_id = $1 AND team_id = $2 AND status = 'pending'
          AND lease_expires_at <= clock_timestamp()`,
      [reservation.requestId, reservation.teamId],
    );
    if (rows.length > 0 && remaining.length === 0) {
      await client.query('COMMIT');
      // All pending rows stayed live.
      return { refreshed: true };
    }
    // Partial refresh: roll back so the rows keep their old (expiring) leases
    // and the stream records the failure; a partial commit would strand one
    // window's row for reclamation while others stay live.
    await client.query('ROLLBACK');
    return { refreshed: false };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // client already aborted the transaction
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function settleBudgetReservation(input: {
  reservation: BudgetReservation;
  actualMicrocents: number;
  actualCostKnown: boolean;
  reasonCode: BudgetReservationReasonCode;
}): Promise<void> {
  if (!Number.isSafeInteger(input.actualMicrocents) || input.actualMicrocents < 0) {
    throw new Error('settlement actualMicrocents must be a non-negative safe integer');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const rows = await lockReservationRows(client, input.reservation.requestId, input.reservation.teamId);
    for (const row of rows) {
      const estimate = decodeMicrocents(row.estimated_microcents, 'reservation.estimated_microcents');
      if (row.status === 'settled' || row.status === 'released') continue;
      if (row.status === 'unknown_held' && !input.actualCostKnown) continue; // idempotent no-op
      if (row.status === 'unknown_held' && input.actualCostKnown) {
        // Inline reconciliation: fence on status; a second call no-ops via 'settled'.
        const lb = decodeMicrocents(row.known_lower_bound_microcents, 'reservation.known_lower_bound_microcents');
        if (input.actualMicrocents < lb) {
          throw new Error(
            `settlement actual ${input.actualMicrocents} below recorded lower bound ${lb}; refusing to reconcile`,
          );
        }
        const held = decodeMicrocents(row.unknown_held_microcents, 'reservation.unknown_held_microcents');
        const { rowCount } = await client.query(
          `UPDATE budget_reservations SET status = 'settled', settled_at = clock_timestamp()
            WHERE id = $1 AND status = 'unknown_held'`,
          [row.id],
        );
        if (rowCount === 0) continue;
        await client.query(
          `UPDATE budget_period_usage SET
             actual_microcents = actual_microcents + $1,
             unknown_held_microcents = unknown_held_microcents - $2,
             unknown_cost_requests = unknown_cost_requests - 1,
             updated_at = now()
           WHERE id = $3`,
          [input.actualMicrocents - lb, held, row.period_id],
        );
        continue;
      }
      // status === 'pending': the only live settlement path.
      const { rowCount } = await client.query(
        `UPDATE budget_reservations SET
           status = $1,
           actual_microcents = $2,
           known_lower_bound_microcents = $3,
           unknown_held_microcents = $4,
           settled_at = clock_timestamp()
         WHERE id = $5 AND status = 'pending'`,
        [
          input.actualCostKnown ? 'settled' : 'unknown_held',
          input.actualMicrocents,
          input.actualCostKnown ? null : input.actualMicrocents,
          input.actualCostKnown ? 0 : Math.max(estimate - input.actualMicrocents, 0),
          row.id,
        ],
      );
      if (rowCount === 0) continue;
      await client.query(
        `UPDATE budget_period_usage SET
           reserved_microcents = reserved_microcents - $1,
           actual_microcents = actual_microcents + $2,
           unknown_held_microcents = unknown_held_microcents + $3,
           unknown_cost_requests = unknown_cost_requests + $4,
           updated_at = now()
         WHERE id = $5`,
        [
          estimate,
          input.actualMicrocents,
          input.actualCostKnown ? 0 : Math.max(estimate - input.actualMicrocents, 0),
          input.actualCostKnown ? 0 : 1,
          row.period_id,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // client already aborted the transaction
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseBudgetReservation(
  reservation: BudgetReservation,
  reasonCode: BudgetReservationReasonCode,
): Promise<void> {
  void reasonCode;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const rows = await lockReservationRows(client, reservation.requestId, reservation.teamId);
    for (const row of rows) {
      // A dispatched row is NEVER released: the dispatch mark is the paid-call
      // fence, and the only terminal transitions for a dispatched row are
      // settlement or lease-reclamation into unknown-held. Mirrors
      // reclaimExpired's dispatched_at partition so the invariant holds at the
      // ledger level, not just in the handlers' in-memory flags.
      if (row.status !== 'pending' || row.dispatched_at != null) continue;
      const estimate = decodeMicrocents(row.estimated_microcents, 'reservation.estimated_microcents');
      const { rowCount } = await client.query(
        `UPDATE budget_reservations SET status = 'released', settled_at = clock_timestamp()
          WHERE id = $1 AND status = 'pending' AND dispatched_at IS NULL`,
        [row.id],
      );
      if (rowCount === 0) continue;
      await client.query(
        `UPDATE budget_period_usage SET
           reserved_microcents = reserved_microcents - $1,
           updated_at = now()
         WHERE id = $2`,
        [estimate, row.period_id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // client already aborted the transaction
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function getBudgetReport(
  teamId: string,
  apiKeyId: string | null,
  now?: Date,
  identityId?: string | null,
): Promise<BudgetReport> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: clockRows } = await client.query<{ db_now: Date }>(
      'SELECT transaction_timestamp() AS db_now',
    );
    const dbNow = now ?? clockRows[0].db_now;
    const windows = getBudgetWindows(dbNow);

    const teamCap = await loadCapRows(client, teamId);
    const identityCap = identityId ? await loadIdentityCapRow(client, teamId, identityId) : null;
    const keyCap = apiKeyId ? await loadKeyCapRow(client, teamId, apiKeyId) : null;
    const scopes = buildScopes(teamCap, identityCap, keyCap, teamId, apiKeyId, identityId ?? null);
    // Admission enforces EVERY scope that carries a cap for a window kind —
    // key, identity, and team can cap DIFFERENT windows independently — so
    // each window reports its own enforcing scope (deepest with a cap for
    // that kind). A single global 'deepest scope' would hide e.g. an
    // identity daily cap behind a key that caps only monthly (and hid team
    // caps behind key caps the same way pre-RSH-140). When no scope caps a
    // kind, the deepest scope still supplies the ledger context (which is
    // empty for uncapped windows).
    const scopeForKind = (kind: BudgetWindowKind): ScopeCaps | null =>
      scopes.find((s) => s.scope === 'key' && s.caps[kind] != null)
      ?? scopes.find((s) => s.scope === 'identity' && s.caps[kind] != null)
      ?? scopes.find((s) => s.scope === 'team' && s.caps[kind] != null)
      // No scope caps this kind. Still surface the DEEPEST scope (name-based,
      // not positional) for residual ledger context: a cap removed after
      // accrual leaves period rows with real committed spend that the report
      // must keep showing (the dashboard by-key surface renders exactly this
      // 'no cap' + real ledger shape). The cap itself is null either way.
      ?? scopes.find((s) => s.scope === 'key')
      ?? scopes.find((s) => s.scope === 'identity')
      ?? scopes.find((s) => s.scope === 'team')
      ?? null;

    const reportWindows: Array<{
      kind: BudgetWindowKind;
      capMicrocents: number | null;
      hardAction: Exclude<BudgetAction, 'ok'> | null;
      alertAtPct: number | null;
      ledger: {
        kind: BudgetWindowKind;
        periodStart: string;
        periodEnd: string;
        resetAt: string;
        actualMicrocents: number;
        reservedMicrocents: number;
        unknownHeldMicrocents: number;
        unknownCostRequests: number;
      } | null;
      hasUnboundedUnknown: boolean;
    }> = [];

    for (const kind of WINDOW_ORDER) {
      const activeScope = scopeForKind(kind);
      if (!activeScope) {
        reportWindows.push({
          kind,
          capMicrocents: null,
          hardAction: null,
          alertAtPct: null,
          ledger: null,
          hasUnboundedUnknown: false,
        });
        continue;
      }
      const cap = activeScope.caps[kind] ?? null;
      const window = windows.find((w) => w.kind === kind)!;
      const id = activeScope.identityId
        ? `${activeScope.teamId}::${activeScope.identityId}:${kind}:${window.periodStart.toISOString()}`
        : `${activeScope.teamId}:${activeScope.apiKeyId ?? ''}:${kind}:${window.periodStart.toISOString()}`;
      const { rows: periodRows } = await client.query<PeriodRow>(
        `SELECT * FROM budget_period_usage WHERE id = $1`,
        [id],
      );
      const period = periodRows[0];
      reportWindows.push({
        kind,
        capMicrocents: cap,
        hardAction: cap != null ? activeScope.hardAction : null,
        alertAtPct: cap != null ? activeScope.alertAtPct : null,
        ledger: period
          ? {
              kind,
              periodStart: period.period_start.toISOString(),
              periodEnd: period.period_end.toISOString(),
              resetAt: window.resetAt,
              actualMicrocents: decodeMicrocents(period.actual_microcents, 'period.actual_microcents'),
              reservedMicrocents: decodeMicrocents(period.reserved_microcents, 'period.reserved_microcents'),
              unknownHeldMicrocents: decodeMicrocents(period.unknown_held_microcents, 'period.unknown_held_microcents'),
              unknownCostRequests: decodeMicrocents(period.unknown_cost_requests, 'period.unknown_cost_requests'),
            }
          : null,
        hasUnboundedUnknown: activeScope ? await scopeHasUnboundedUnknown(client, activeScope) : false,
      });
    }

    const report = buildBudgetReport({ windows: reportWindows });
    await client.query('COMMIT');
    return report as unknown as BudgetReport;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // client already aborted the transaction
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function resolveBudgetUnknownReservation(input: {
  teamId: string;
  requestId: string;
  confirmedRawCostMicrocents: number;
  evidence: string;
  note: string;
  resolvedBy: string;
}): Promise<{
  alreadyResolved: boolean;
  actualAddedMicrocents: number;
  releasedMicrocents: number;
}> {
  const confirmed = input.confirmedRawCostMicrocents;
  if (!Number.isSafeInteger(confirmed) || confirmed < 0) {
    throw new Error('confirmedRawCostMicrocents must be a non-negative safe integer');
  }
  if (input.evidence.trim().length === 0 || input.note.trim().length === 0 || input.resolvedBy.trim().length === 0) {
    throw new Error('evidence, note, and resolvedBy are required');
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Lock all period rows for the team (team scope first, then key scope;
    // daily -> weekly -> monthly within a scope).
    await client.query(
      `SELECT id FROM budget_period_usage
        WHERE team_id = $1
        ORDER BY (api_key_id IS NOT NULL), (identity_id IS NOT NULL),
          CASE window_kind WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END,
          period_start FOR UPDATE`,
      [input.teamId],
    );
    const rows = await lockReservationRows(client, input.requestId, input.teamId);

    let actualAddedMicrocents = 0;
    let releasedMicrocents = 0;
    let resolvedAny = false;

    for (const row of rows) {
      if (row.status !== 'unknown_held') continue;
      const lb = decodeMicrocents(row.known_lower_bound_microcents, 'reservation.known_lower_bound_microcents');
      if (confirmed < lb) {
        throw new Error(
          `confirmed ${confirmed} below recorded lower bound ${lb}; refusing to resolve`,
        );
      }
      const held = decodeMicrocents(row.unknown_held_microcents, 'reservation.unknown_held_microcents');
      const { rowCount } = await client.query(
        `UPDATE budget_reservations SET status = 'settled', settled_at = clock_timestamp()
          WHERE id = $1 AND status = 'unknown_held'`,
        [row.id],
      );
      if (rowCount === 0) continue;
      resolvedAny = true;
      const delta = confirmed - lb;
      actualAddedMicrocents += delta;
      releasedMicrocents += held;
      await client.query(
        `UPDATE budget_period_usage SET
           actual_microcents = actual_microcents + $1,
           unknown_held_microcents = unknown_held_microcents - $2,
           unknown_cost_requests = unknown_cost_requests - 1,
           updated_at = now()
         WHERE id = $3`,
        [delta, held, row.period_id],
      );
    }

    // Resolve seed-ledger unknowns in the same transaction, team-scoped.
    const { rows: seedRows } = await client.query<{ period_id: string; seed_actual_microcents: string }>(
      `UPDATE budget_period_seeded_requests s SET known_cost = true
         FROM budget_period_usage p
        WHERE p.id = s.period_id AND p.team_id = $1
          AND s.request_id = $2 AND s.known_cost = false
        RETURNING s.period_id, s.actual_microcents AS seed_actual_microcents`,
      [input.teamId, input.requestId],
    );
    for (const seed of seedRows) {
      resolvedAny = true;
      const seedActual = decodeMicrocents(seed.seed_actual_microcents, 'seed.actual_microcents');
      // Mirror the reservation branch: the logged amount is a recorded lower
      // bound — a confirmed cost below it is evidence of a bad log, never a
      // reason to silently keep the overstated aggregate.
      if (confirmed < seedActual) {
        await client.query('ROLLBACK');
        throw new Error(
          `confirmed ${confirmed} below recorded seed lower bound ${seedActual}; refusing to resolve`,
        );
      }
      const delta = confirmed - seedActual;
      actualAddedMicrocents += delta;
      await client.query(
        `UPDATE budget_period_usage SET
           actual_microcents = actual_microcents + $1,
           unknown_cost_requests = unknown_cost_requests - 1,
           updated_at = now()
         WHERE id = $2`,
        [delta, seed.period_id],
      );
    }

    await client.query('COMMIT');
    return { alreadyResolved: !resolvedAny, actualAddedMicrocents, releasedMicrocents };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // client already aborted the transaction
    }
    throw err;
  } finally {
    client.release();
  }
}
