// RSH-138: team-scoped three-window budget report loader. Read-only; reads the
// config row plus current budget_period_usage rows and delegates ALL committed
// arithmetic, status, and action precedence to the pure buildBudgetReport
// serializer in @routeshift/shared — never reimplemented here, and never
// importing the proxy's pg-backed modules.

import {
  buildBudgetReport,
  getBudgetWindows,
  type BudgetWindowInput,
  type BudgetWindowKind,
} from '@routeshift/shared';
import { getPool } from '@/lib/db';

const MICROCENTS_PER_USD = 100_000_000;

interface TeamBudgetConfigRow {
  daily_usd_cap: string | null;
  weekly_usd_cap: string | null;
  monthly_usd_cap: string | null;
  alert_at_pct: number | null;
  hard_cap_action: 'alert' | 'throttle' | 'block' | null;
}

interface PeriodUsageRow {
  window_kind: BudgetWindowKind;
  period_start: Date;
  period_end: Date;
  actual_microcents: string;
  reserved_microcents: string;
  unknown_held_microcents: string;
  unknown_cost_requests: string;
}

function decodeBigintMicrocents(value: string, column: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`Invalid ${column} in budget_period_usage: ${value}`);
  }
  return n;
}

function decodeUsdCap(value: string | null): number | null {
  if (value == null) return null;
  const microcents = Math.round(Number(value) * MICROCENTS_PER_USD);
  return Number.isSafeInteger(microcents) ? microcents : null;
}

/**
 * Load the team's current daily/weekly/monthly report. `teamId` must already
 * be the authenticated effective team; this function never trusts a
 * client-supplied team id. Returns USD-serialized windows plus the shared
 * qualification flag.
 */
export async function loadBudgetReport(teamId: string, now = new Date()): Promise<{
  windows: Array<{
    kind: BudgetWindowKind;
    cap_usd: number | null;
    known_spend_usd: number;
    reserved_usd: number;
    unknown_held_usd: number;
    committed_usd: number;
    unknown_cost_requests: number;
    status: 'ok' | 'alert' | 'throttle' | 'block';
    action: 'alert' | 'throttle' | 'block' | null;
    period_start: string;
    period_end: string;
    reset_at: string;
  }>;
  actual_costs_qualified: boolean;
}> {
  const pool = getPool();
  const windows = getBudgetWindows(now);

  const [{ rows: configRows }, { rows: periodRows }, { rows: unboundedRows }] = await Promise.all([
    pool.query<TeamBudgetConfigRow>(
      `SELECT daily_usd_cap, weekly_usd_cap, monthly_usd_cap, alert_at_pct, hard_cap_action
       FROM team_budgets WHERE team_id = $1`,
      [teamId],
    ),
    pool.query<PeriodUsageRow>(
      `SELECT window_kind, period_start, period_end,
              actual_microcents, reserved_microcents, unknown_held_microcents, unknown_cost_requests
       FROM budget_period_usage
       WHERE team_id = $1 AND api_key_id IS NULL AND identity_id IS NULL AND window_kind = ANY($2)
         AND period_start = ANY($3)`,
      [
        teamId,
        windows.map((w) => w.kind),
        windows.map((w) => w.periodStart),
      ],
    ),
    pool.query<{ period_id: string }>(
      // Unresolved unbounded unknown rows gate the scope's hard caps. Mirrors
      // the proxy reservation service's exact predicate: zero-estimate
      // unknown_held rows, in-flight estimate_unavailable rows, and unresolved
      // seed rows all count (a zero estimate contributes zero held, so the
      // held-amount filter would miss it).
      `SELECT DISTINCT r.period_id
         FROM budget_reservations r JOIN budget_period_usage p ON p.id = r.period_id
        WHERE p.team_id = $1 AND p.api_key_id IS NULL AND p.identity_id IS NULL
          AND ((r.status = 'unknown_held' AND r.estimated_microcents = 0)
            OR (r.status = 'pending' AND r.estimate_unavailable = true))
       UNION
       SELECT DISTINCT s.period_id
         FROM budget_period_seeded_requests s JOIN budget_period_usage p ON p.id = s.period_id
        WHERE p.team_id = $1 AND p.api_key_id IS NULL AND p.identity_id IS NULL AND s.known_cost = false`,
      [teamId],
    ),
  ]);

  const config = configRows[0] ?? null;
  const caps: Record<BudgetWindowKind, number | null> = {
    daily: decodeUsdCap(config?.daily_usd_cap ?? null),
    weekly: decodeUsdCap(config?.weekly_usd_cap ?? null),
    monthly: decodeUsdCap(config?.monthly_usd_cap ?? null),
  };
  const alertAtPct = config?.alert_at_pct ?? null;
  const hardAction = (config?.hard_cap_action ?? 'alert') as Exclude<'alert' | 'throttle' | 'block', 'ok'>;

  const periodByKind = new Map<BudgetWindowKind, PeriodUsageRow>();
  for (const row of periodRows) periodByKind.set(row.window_kind, row);
  const unboundedPeriodIds = new Set(unboundedRows.map((r) => r.period_id));

  const reportWindows: BudgetWindowInput[] = windows.map((window) => {
    const period = periodByKind.get(window.kind);
    const capMicrocents = caps[window.kind];
    const periodId = `${teamId}::${window.kind}:${window.periodStart.toISOString()}`;
    return {
      kind: window.kind,
      capMicrocents,
      hardAction: capMicrocents != null ? hardAction : null,
      alertAtPct: capMicrocents != null ? alertAtPct : null,
      ledger: period
        ? {
            kind: window.kind,
            periodStart: period.period_start.toISOString(),
            periodEnd: period.period_end.toISOString(),
            resetAt: window.resetAt,
            actualMicrocents: decodeBigintMicrocents(period.actual_microcents, 'actual_microcents'),
            reservedMicrocents: decodeBigintMicrocents(period.reserved_microcents, 'reserved_microcents'),
            unknownHeldMicrocents: decodeBigintMicrocents(period.unknown_held_microcents, 'unknown_held_microcents'),
            unknownCostRequests: decodeBigintMicrocents(period.unknown_cost_requests, 'unknown_cost_requests'),
          }
        : null,
      hasUnboundedUnknown: unboundedPeriodIds.has(periodId),
    };
  });

  const report = buildBudgetReport({ windows: reportWindows });
  const windowByKind = new Map(windows.map((w) => [w.kind, w]));

  return {
    windows: report.windows.map((w) => {
      // The shared serializer carries bounds only on seeded ledger rows; the
      // dashboard always has the computed UTC window, so fill unseeded rows.
      const computed = windowByKind.get(w.kind)!;
      const periodStart = w.periodStart || computed.periodStart.toISOString();
      const periodEnd = w.periodEnd || computed.periodEnd.toISOString();
      const resetAt = w.resetAt || computed.resetAt;
      return {
        kind: w.kind,
        cap_usd: w.capMicrocents != null ? w.capMicrocents / MICROCENTS_PER_USD : null,
        known_spend_usd: w.actualMicrocents / MICROCENTS_PER_USD,
        reserved_usd: w.reservedMicrocents / MICROCENTS_PER_USD,
        unknown_held_usd: w.unknownHeldMicrocents / MICROCENTS_PER_USD,
        committed_usd: w.committedMicrocents / MICROCENTS_PER_USD,
        unknown_cost_requests: w.unknownCostRequests,
        status: w.status,
        action: w.action,
        period_start: periodStart,
        period_end: periodEnd,
        reset_at: resetAt,
      };
    }),
    actual_costs_qualified: report.actualCostsQualified,
  };
}
