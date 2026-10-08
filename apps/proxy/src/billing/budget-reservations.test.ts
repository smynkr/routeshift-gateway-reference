/**
 * RSH-138 lifecycle tests against a stateful fake transaction client.
 * The fake models budget_period_usage / budget_reservations /
 * budget_period_seeded_requests / request_logs / team_budgets / api_keys
 * rows and dispatches the service's SQL by statement shape; it never asserts
 * SQL strings. Clock semantics are modeled: transaction_timestamp() returns
 * the fake's settable now, clock_timestamp() the same clock (advance it to
 * age leases), and lock acquisition is recorded to verify canonical order.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BudgetWindowKind } from '@routeshift/shared';
import {
  reserveBudget,
  adjustBudgetReservation,
  markBudgetReservationDispatched,
  refreshBudgetReservationLease,
  settleBudgetReservation,
  releaseBudgetReservation,
  getBudgetReport,
  resolveBudgetUnknownReservation,
  type BudgetReservation,
} from './budget-reservations.js';
import type { BudgetEstimate } from './budget-estimate.js';

const { testHooks } = vi.hoisted(() => ({
  testHooks: { client: null as unknown },
}));

vi.mock('../db/pool.js', () => ({
  getPool: () => ({
    connect: async () => testHooks.client,
  }),
}));

interface FakePeriodRow {
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
  seeded_request_count: number;
}

interface FakeReservationRow {
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

interface FakeSeedRow {
  period_id: string;
  request_id: string;
  actual_microcents: string;
  known_cost: boolean;
}

interface FakeLogRow {
  id: string;
  team_id: string;
  api_key_id: string | null;
  layer_identity_id: string | null;
  timestamp: Date;
  actual_cost_microcents: string;
  plugin_cost_microcents: string | null;
  actual_cost_known: boolean;
}

interface TeamBudgetRow {
  team_id: string;
  daily_usd_cap: string | null;
  weekly_usd_cap: string | null;
  monthly_usd_cap: string | null;
  hard_cap_action: 'alert' | 'throttle' | 'block';
  alert_at_pct: number | null;
}

interface IdentityCapRow {
  team_id: string;
  identity_id: string;
  daily_usd_cap: string | null;
  weekly_usd_cap: string | null;
  monthly_usd_cap: string | null;
  cap_action: 'alert' | 'throttle' | 'block';
  soft_alert_at_pct: number | null;
}

interface KeyCapRow {
  id: string;
  team_id: string;
  daily_usd_cap: string | null;
  weekly_usd_cap: string | null;
  monthly_usd_cap: string | null;
  cap_action: 'alert' | 'throttle' | 'block';
  soft_alert_at_pct: number | null;
}

const USD = 100_000_000;

class FakeDb {
  now = new Date('2026-08-09T12:00:00.000Z');
  periods = new Map<string, FakePeriodRow>();
  reservations = new Map<string, FakeReservationRow>();
  seeds = new Map<string, FakeSeedRow>();
  logs: FakeLogRow[] = [];
  teamBudgets = new Map<string, TeamBudgetRow>();
  keyCaps = new Map<string, KeyCapRow>();
  identityCaps = new Map<string, IdentityCapRow>();
  lockOrder: string[] = [];
  committed = false;
  rolledBack = false;

  period(team: string, key: string | null, kind: BudgetWindowKind, identity: string | null = null): FakePeriodRow {
    const window = this.windowFor(kind);
    // mirrors the service's two id namespaces exactly:
    // team/key rows: team:key:kind:start (legacy format), identity rows: team::identity:kind:start
    const id = identity != null
      ? `${team}::${identity}:${kind}:${window.periodStart.toISOString()}`
      : `${team}:${key ?? ''}:${kind}:${window.periodStart.toISOString()}`;
    let row = this.periods.get(id);
    if (!row) {
      row = {
        id,
        team_id: team,
        api_key_id: key,
        identity_id: identity,
        window_kind: kind,
        period_start: window.periodStart,
        period_end: window.periodEnd,
        reserved_microcents: '0',
        unknown_held_microcents: '0',
        actual_microcents: '0',
        unknown_cost_requests: '0',
        seeded_through: null,
        seeded_request_count: 0,
      };
      this.periods.set(id, row);
    }
    return row;
  }

  cap(team: string, key: string | null, kind: BudgetWindowKind, microcents: number | null, action: 'alert' | 'throttle' | 'block' = 'block', alertPct: number | null = 80): void {
    const col = `${kind}_usd_cap` as 'daily_usd_cap' | 'weekly_usd_cap' | 'monthly_usd_cap';
    const usd = microcents == null ? null : (microcents / USD).toFixed(8);
    if (key == null) {
      const row = this.teamBudgets.get(team) ?? { team_id: team, daily_usd_cap: null, weekly_usd_cap: null, monthly_usd_cap: null, hard_cap_action: 'alert', alert_at_pct: 80 };
      row[col] = usd;
      row.hard_cap_action = action;
      row.alert_at_pct = alertPct;
      this.teamBudgets.set(team, row);
    } else {
      const row = this.keyCaps.get(key) ?? { id: key, team_id: team, daily_usd_cap: null, weekly_usd_cap: null, monthly_usd_cap: null, cap_action: 'alert', soft_alert_at_pct: 80 };
      row[col] = usd;
      row.cap_action = action;
      row.soft_alert_at_pct = alertPct;
      this.keyCaps.set(key, row);
    }
  }

  capIdentity(team: string, identity: string, kind: BudgetWindowKind, microcents: number | null, action: 'alert' | 'throttle' | 'block' = 'block', alertPct: number | null = 80): void {
    const col = `${kind}_usd_cap` as 'daily_usd_cap' | 'weekly_usd_cap' | 'monthly_usd_cap';
    const usd = microcents == null ? null : (microcents / USD).toFixed(8);
    const key = `${team}:${identity}`;
    const row = this.identityCaps.get(key) ?? { team_id: team, identity_id: identity, daily_usd_cap: null, weekly_usd_cap: null, monthly_usd_cap: null, cap_action: 'alert', soft_alert_at_pct: 80 };
    row[col] = usd;
    row.cap_action = action;
    row.soft_alert_at_pct = alertPct;
    this.identityCaps.set(key, row);
  }

  log(row: Partial<FakeLogRow> & { id: string; team_id: string; timestamp: Date; actual_cost_microcents: string; actual_cost_known: boolean }): void {
    row.layer_identity_id = row.layer_identity_id ?? null;
    row.api_key_id = row.api_key_id ?? null;
    row.plugin_cost_microcents = row.plugin_cost_microcents ?? null;
    this.logs.push({
      api_key_id: null,
      plugin_cost_microcents: null,
      ...row,
    } as FakeLogRow);
  }

  addReservation(row: Partial<FakeReservationRow> & { period_id: string; request_id: string }): FakeReservationRow {
    const full: FakeReservationRow = {
      id: `${row.period_id}:${row.request_id}`,
      team_id: row.team_id ?? 'team-a',
      api_key_id: row.api_key_id ?? null,
      estimated_microcents: '0',
      actual_microcents: '0',
      unknown_held_microcents: '0',
      known_lower_bound_microcents: null,
      estimate_unavailable: false,
      status: 'pending',
      lease_expires_at: new Date(this.now.getTime() + 600_000),
      dispatched_at: null,
      ...row,
    } as FakeReservationRow;
    this.reservations.set(full.id, full);
    return full;
  }

  advance(ms: number): void {
    this.now = new Date(this.now.getTime() + ms);
  }

  private windowFor(kind: BudgetWindowKind): { periodStart: Date; periodEnd: Date } {
    const d = this.now;
    if (kind === 'daily') {
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      return { periodStart: start, periodEnd: new Date(start.getTime() + 86_400_000) };
    }
    if (kind === 'weekly') {
      const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const daysSinceMonday = (start.getUTCDay() + 6) % 7;
      const monday = new Date(start.getTime() - daysSinceMonday * 86_400_000);
      return { periodStart: monday, periodEnd: new Date(monday.getTime() + 7 * 86_400_000) };
    }
    return {
      periodStart: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
      periodEnd: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
    };
  }

  // --- dispatcher -------------------------------------------------------

  release(): void {
    // no-op for the in-memory fake
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number | null }> {
    if (sql === 'BEGIN') return { rows: [], rowCount: null };
    if (sql === 'COMMIT') { this.committed = true; return { rows: [], rowCount: null }; }
    if (sql === 'ROLLBACK') { this.rolledBack = true; return { rows: [], rowCount: null }; }
    const s = sql.replace(/\s+/g, ' ');
    if (sql.startsWith('SELECT transaction_timestamp()')) {
      return { rows: [{ db_now: this.now }], rowCount: null };
    }
    if (s.includes('FROM team_budgets WHERE team_id::text')) {
      const row = this.teamBudgets.get(String(params[0]));
      return {
        rows: row
          ? [{
              daily_usd_cap: row.daily_usd_cap,
              weekly_usd_cap: row.weekly_usd_cap,
              monthly_usd_cap: row.monthly_usd_cap,
              hard_cap_action: row.hard_cap_action,
              alert_at_pct: row.alert_at_pct,
            }]
          : [],
        rowCount: null,
      };
    }
    if (s.includes('FROM identity_budget_caps WHERE team_id = $1 AND identity_id = $2')) {
      const row = this.identityCaps.get(`${String(params[0])}:${String(params[1])}`);
      return {
        rows: row
          ? [{
              daily_usd_cap: row.daily_usd_cap,
              weekly_usd_cap: row.weekly_usd_cap,
              monthly_usd_cap: row.monthly_usd_cap,
              cap_action: row.cap_action,
              soft_alert_at_pct: row.soft_alert_at_pct,
            }]
          : [],
        rowCount: null,
      };
    }
    if (s.includes('FROM api_keys WHERE id = $1 AND team_id = $2')) {
      const row = this.keyCaps.get(String(params[0]));
      return {
        rows: row
          ? [{
              daily_usd_cap: row.daily_usd_cap,
              weekly_usd_cap: row.weekly_usd_cap,
              monthly_usd_cap: row.monthly_usd_cap,
              cap_action: row.cap_action,
              soft_alert_at_pct: row.soft_alert_at_pct,
            }]
          : [],
        rowCount: null,
      };
    }
    if (sql.startsWith('INSERT INTO budget_period_usage')) {
      const [id, team, key, identity, kind, start, end] = params as [string, string, string | null, string | null, BudgetWindowKind, Date, Date];
      const existing = this.periods.get(id);
      if (!existing) {
        this.periods.set(id, {
          id, team_id: team, api_key_id: key, identity_id: identity, window_kind: kind,
          period_start: start, period_end: end,
          reserved_microcents: '0', unknown_held_microcents: '0', actual_microcents: '0',
          unknown_cost_requests: '0', seeded_through: null, seeded_request_count: 0,
        });
      }
      return { rows: [], rowCount: null };
    }
    if (s.includes('FROM budget_period_usage WHERE id = $1') && s.includes('FOR UPDATE')) {
      const id = String(params[0]);
      this.lockOrder.push(`period:${id}`);
      return { rows: this.periods.get(id) ? [this.periods.get(id)!] : [], rowCount: null };
    }
    if (s.includes('FROM budget_period_usage WHERE id = $1') && !s.includes('JOIN')) {
      const id = String(params[0]);
      return { rows: this.periods.get(id) ? [this.periods.get(id)!] : [], rowCount: null };
    }
    if (sql.startsWith('WITH newly AS')) {
      const [periodId, team, key, identity, lookback, periodEnd] = params as [string, string, string | null, string | null, Date, Date];
      const period = this.periods.get(periodId)!;
      // Team scope counts ALL team logs (key-attributed or not); key scope
      // filters to that key. The lookback is already clamped to period_start.
      const candidates = this.logs.filter(
        (l) => l.team_id === team
          && (key == null ? true : l.api_key_id === key)
          && (identity == null ? true : l.layer_identity_id === identity)
          && l.timestamp >= lookback && l.timestamp < periodEnd,
      );
      let seededCount = 0;
      let newUnknown = 0;
      let newActual = 0;
      let maxTs: Date | null = null;
      for (const l of candidates) {
        if (l.timestamp > (maxTs ?? l.timestamp)) maxTs = l.timestamp;
        const seedKey = `${periodId}:${l.id}`;
        if (this.seeds.has(seedKey)) continue;
        const existing = this.reservations.get(`${periodId}:${l.id}`);
        if (existing && existing.status !== 'released') continue;
        const amount = Number(l.actual_cost_microcents) + Number(l.plugin_cost_microcents ?? 0);
        this.seeds.set(seedKey, { period_id: periodId, request_id: l.id, actual_microcents: String(amount), known_cost: l.actual_cost_known });
        seededCount += 1;
        newActual += amount;
        if (!l.actual_cost_known) newUnknown += 1;
      }
      period.seeded_through = maxTs ? new Date(Math.max(maxTs.getTime(), period.seeded_through?.getTime() ?? 0)) : period.seeded_through;
      period.seeded_request_count += seededCount;
      period.actual_microcents = String(Number(period.actual_microcents) + newActual);
      period.unknown_cost_requests = String(Number(period.unknown_cost_requests) + newUnknown);
      return {
        rows: [{ seeded_count: String(seededCount), new_unknown_count: String(newUnknown), new_actual: String(newActual) }],
        rowCount: null,
      };
    }
    if (sql.startsWith('WITH expired AS')) {
      const periodId = String(params[0]);
      const period = this.periods.get(periodId)!;
      let releasedAmount = 0;
      let convertedAmount = 0;
      let releasedCount = 0;
      let convertedCount = 0;
      for (const r of [...this.reservations.values()]) {
        if (r.period_id !== periodId || r.status !== 'pending') continue;
        if (r.lease_expires_at > this.now) continue;
        const amount = Number(r.estimated_microcents);
        if (r.dispatched_at == null) {
          r.status = 'released';
          releasedAmount += amount;
          releasedCount += 1;
        } else {
          r.status = 'unknown_held';
          r.unknown_held_microcents = String(amount);
          r.known_lower_bound_microcents = '0';
          convertedAmount += amount;
          convertedCount += 1;
        }
      }
      period.reserved_microcents = String(Number(period.reserved_microcents) - releasedAmount - convertedAmount);
      period.unknown_held_microcents = String(Number(period.unknown_held_microcents) + convertedAmount);
      period.unknown_cost_requests = String(Number(period.unknown_cost_requests) + convertedCount);
      return {
        rows: [{ released_amount: String(releasedAmount), converted_amount: String(convertedAmount) }],
        rowCount: releasedCount + convertedCount,
      };
    }
    if (sql.startsWith('SELECT EXISTS (')) {
      const team = String(params[0]);
      const key = params.length > 1 ? String(params[1]) : null;
      const unbounded = [...this.reservations.values()].some(
        (r) => r.team_id === team
          && (key == null ? r.api_key_id == null : r.api_key_id === key)
          && ((r.status === 'unknown_held' && Number(r.estimated_microcents) === 0)
            || (r.status === 'pending' && r.estimate_unavailable)),
      ) || [...this.seeds.values()].some((s) => {
        const p = this.periods.get(s.period_id)!;
        return p.team_id === team && (key == null ? p.api_key_id == null : p.api_key_id === key) && !s.known_cost;
      });
      return { rows: [{ exists: unbounded }], rowCount: null };
    }
    if (s.includes('INSERT INTO budget_reservations')) {
      const [id, periodId, requestId, team, key, identity, estimate, estimateUnavailable, leaseSecs] = params as
        [string, string, string, string, string | null, string | null, number, boolean, number];
      if (this.reservations.has(id)) {
        return { rows: [], rowCount: null };
      }
      const row: FakeReservationRow = {
        id, period_id: periodId, request_id: requestId, team_id: team, api_key_id: key, identity_id: identity,
        estimated_microcents: String(estimate), actual_microcents: '0', unknown_held_microcents: '0',
        known_lower_bound_microcents: null, estimate_unavailable: estimateUnavailable,
        status: 'pending', lease_expires_at: new Date(this.now.getTime() + leaseSecs * 1000), dispatched_at: null,
      };
      this.reservations.set(id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.includes('UPDATE budget_period_usage SET reserved_microcents = reserved_microcents + $1')) {
      const [delta, periodId] = params as [number, string];
      const p = this.periods.get(periodId)!;
      p.reserved_microcents = String(Number(p.reserved_microcents) + delta);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('UPDATE budget_period_usage SET') && s.includes('actual_microcents = actual_microcents + $1')
      && s.includes('unknown_held_microcents = unknown_held_microcents - $2')) {
      const [delta, held, periodId] = params as [number, number, string];
      const p = this.periods.get(periodId)!;
      p.actual_microcents = String(Number(p.actual_microcents) + delta);
      p.unknown_held_microcents = String(Number(p.unknown_held_microcents) - held);
      p.unknown_cost_requests = String(Number(p.unknown_cost_requests) - 1);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('UPDATE budget_period_usage SET') && s.includes('unknown_cost_requests = unknown_cost_requests - 1')) {
      const [delta, periodId] = params as [number, string];
      const p = this.periods.get(periodId)!;
      p.actual_microcents = String(Number(p.actual_microcents) + delta);
      p.unknown_cost_requests = String(Number(p.unknown_cost_requests) - 1);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('UPDATE budget_period_usage SET') && s.includes('actual_microcents = actual_microcents + $2')) {
      const [estimate, actual, held, count, periodId] = params as [number, number, number, number, string];
      const p = this.periods.get(periodId)!;
      p.reserved_microcents = String(Number(p.reserved_microcents) - estimate);
      p.actual_microcents = String(Number(p.actual_microcents) + actual);
      p.unknown_held_microcents = String(Number(p.unknown_held_microcents) + held);
      p.unknown_cost_requests = String(Number(p.unknown_cost_requests) + count);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('UPDATE budget_period_usage SET reserved_microcents = reserved_microcents - $1')) {
      const [estimate, periodId] = params as [number, string];
      const p = this.periods.get(periodId)!;
      p.reserved_microcents = String(Number(p.reserved_microcents) - estimate);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('UPDATE budget_period_usage SET') && s.includes('actual_microcents = actual_microcents + $2')) {
      // unreachable duplicate guard
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('SELECT p.id FROM budget_period_usage p') && s.includes('FOR UPDATE OF p')) {
      const requestId = String(params[0]);
      const requestPeriods = [...this.reservations.values()].filter((r) => r.request_id === requestId).map((r) => r.period_id);
      const WINDOW_RANK: Record<string, number> = { daily: 0, weekly: 1, monthly: 2 };
      const ordered = requestPeriods
        .map((pid) => this.periods.get(pid)!)
        .sort((a, b) => {
          const scope = (a.api_key_id == null ? 0 : 1) - (b.api_key_id == null ? 0 : 1);
          if (scope !== 0) return scope;
          const rank = WINDOW_RANK[a.window_kind] - WINDOW_RANK[b.window_kind];
          if (rank !== 0) return rank;
          return a.period_start.getTime() - b.period_start.getTime();
        });
      for (const p of ordered) this.lockOrder.push(`period:${p.id}`);
      return { rows: [], rowCount: null };
    }
    if (s.includes('SELECT r.* FROM budget_reservations r') && s.includes('JOIN budget_period_usage p')) {
      const requestId = String(params[0]);
      const rows = [...this.reservations.values()]
        .filter((r) => r.request_id === requestId)
        .sort((a, b) => {
          const pa = this.periods.get(a.period_id)!;
          const pb = this.periods.get(b.period_id)!;
          const scope = (a.api_key_id == null ? 0 : 1) - (b.api_key_id == null ? 0 : 1);
          if (scope !== 0) return scope;
          const WINDOW_RANK: Record<string, number> = { daily: 0, weekly: 1, monthly: 2 };
          const rank = WINDOW_RANK[pa.window_kind] - WINDOW_RANK[pb.window_kind];
          if (rank !== 0) return rank;
          return pa.period_start.getTime() - pb.period_start.getTime();
        });
      if (s.includes('FOR UPDATE OF r')) {
        for (const r of rows) this.lockOrder.push(`reservation:${r.request_id}`);
      }
      // Copies, not aliases: a later UPDATE in the same transaction mutates
      // the map rows in place (mirroring Postgres MVCC would not).
      return { rows: rows.map((r) => ({ ...r })), rowCount: null };
    }
    if (sql.startsWith('SELECT * FROM budget_reservations WHERE request_id = $1 AND team_id = $2')) {
      const requestId = String(params[0]);
      return {
        rows: [...this.reservations.values()].filter((r) => r.request_id === requestId).sort((a, b) => a.period_id.localeCompare(b.period_id)),
        rowCount: null,
      };
    }
    if (sql.startsWith('SELECT id FROM budget_reservations') && s.includes('dispatched_at IS NULL') && s.includes("status = 'pending'")) {
      const [requestId, teamId] = params as [string, string];
      const rows = [...this.reservations.values()].filter(
        (r) => r.request_id === requestId && r.team_id === teamId && r.status === 'pending' && r.dispatched_at == null,
      ).map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT id FROM budget_reservations') && s.includes('lease_expires_at <= clock_timestamp()')) {
      const [requestId, teamId] = params as [string, string];
      const rows = [...this.reservations.values()].filter(
        (r) => r.request_id === requestId && r.team_id === teamId && r.status === 'pending' && r.lease_expires_at <= this.now,
      ).map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT dispatched_at, status FROM budget_reservations')) {
      const requestId = String(params[0]);
      return {
        rows: [...this.reservations.values()].filter((r) => r.request_id === requestId).map((r) => ({ dispatched_at: r.dispatched_at, status: r.status })),
        rowCount: null,
      };
    }
    if (s.includes('UPDATE budget_reservations SET') && s.includes('dispatched_at = clock_timestamp()')) {
      const [leaseSecs, requestId, teamId] = params as [number, string, string];
      const live = [...this.reservations.values()].filter(
        (r) => r.request_id === requestId && r.team_id === teamId && r.status === 'pending' && r.dispatched_at == null && r.lease_expires_at > this.now,
      );
      const allLive = [...this.reservations.values()].filter(
        (r) => r.request_id === requestId && r.team_id === teamId && r.status === 'pending' && r.dispatched_at == null,
      );
      // Prod rolls back a partial mark; only mutate when every pending row is live.
      if (live.length === allLive.length && allLive.length > 0) {
        for (const r of live) {
          r.dispatched_at = this.now;
          r.lease_expires_at = new Date(this.now.getTime() + leaseSecs * 1000);
        }
      }
      return { rows: live.map((r) => ({ id: r.id })), rowCount: live.length };
    }
    if (s.includes('UPDATE budget_reservations SET') && s.includes('lease_expires_at = clock_timestamp() + make_interval(secs => $1)') && s.includes('WHERE request_id = $2')) {
      const [leaseSecs, requestId, teamId] = params as [number, string, string];
      const live = [...this.reservations.values()].filter(
        (r) => r.request_id === requestId && r.team_id === teamId && r.status === 'pending' && r.lease_expires_at > this.now,
      );
      const allLive = [...this.reservations.values()].filter(
        (r) => r.request_id === requestId && r.team_id === teamId && r.status === 'pending',
      );
      if (live.length === allLive.length && allLive.length > 0) {
        for (const r of live) r.lease_expires_at = new Date(this.now.getTime() + leaseSecs * 1000);
      }
      return { rows: live.map((r) => ({ id: r.id })), rowCount: live.length };
    }
    if (s.includes('UPDATE budget_reservations SET') && s.includes('estimated_microcents = $1') && s.includes('request_id = $3 AND team_id = $4')) {
      const [estimate, leaseSecs, requestId, teamId] = params as [number, number, string, string];
      const targets = [...this.reservations.values()].filter(
        (r) => r.request_id === requestId && r.team_id === teamId && r.status === 'pending' && r.lease_expires_at > this.now,
      );
      for (const r of targets) {
        r.estimated_microcents = String(estimate);
        r.lease_expires_at = new Date(this.now.getTime() + leaseSecs * 1000);
      }
      return { rows: targets.map((r) => ({ id: r.id, period_id: r.period_id })), rowCount: targets.length };
    }
    if (s.includes('UPDATE budget_reservations SET') && s.includes('WHERE request_id = $3 AND status = \'pending\' AND lease_expires_at > clock_timestamp()')) {
      const [estimate, leaseSecs, requestId] = params as [number, number, string];
      const targets = [...this.reservations.values()].filter(
        (r) => r.request_id === requestId && r.status === 'pending' && r.lease_expires_at > this.now,
      );
      for (const r of targets) {
        r.estimated_microcents = String(estimate);
        r.lease_expires_at = new Date(this.now.getTime() + leaseSecs * 1000);
      }
      return { rows: targets.map((r) => ({ id: r.id, period_id: r.period_id })), rowCount: targets.length };
    }
    if (s.includes('UPDATE budget_reservations SET status = \'settled\', settled_at = clock_timestamp()') && s.includes("status = 'unknown_held'")) {
      const id = String(params[0]);
      const r = this.reservations.get(id);
      if (!r || r.status !== 'unknown_held') return { rows: [], rowCount: 0 };
      r.status = 'settled';
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('UPDATE budget_reservations SET status = $1') && s.includes("WHERE id = $5 AND status = 'pending'")) {
      const [status, actual, lb, held, id] = params as [string, number, number | null, number, string];
      const r = this.reservations.get(id);
      if (!r || r.status !== 'pending') return { rows: [], rowCount: 0 };
      r.status = status as FakeReservationRow['status'];
      r.actual_microcents = String(actual);
      r.known_lower_bound_microcents = lb == null ? null : String(lb);
      r.unknown_held_microcents = String(held);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("UPDATE budget_reservations SET status = 'released', settled_at = clock_timestamp()")) {
      const id = String(params[0]);
      const r = this.reservations.get(id);
      if (!r || r.status !== 'pending' || r.dispatched_at != null) return { rows: [], rowCount: 0 };
      r.status = 'released';
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('UPDATE budget_period_seeded_requests s SET known_cost = true')) {
      const [team, requestId] = params as [string, string];
      const affected: Array<{ period_id: string; seed_actual_microcents: string }> = [];
      for (const [, s] of [...this.seeds.entries()]) {
        const p = this.periods.get(s.period_id);
        if (!p || p.team_id !== team || s.request_id !== requestId || s.known_cost) continue;
        s.known_cost = true;
        affected.push({ period_id: s.period_id, seed_actual_microcents: s.actual_microcents });
      }
      return { rows: affected, rowCount: affected.length };
    }
    if (sql.startsWith('SELECT p.* FROM budget_period_usage p') && s.includes('period_end <')) {
      const [team, kind, dbNow, key] = params as [string, BudgetWindowKind, Date, string | undefined];
      const rows = [...this.periods.values()].filter(
        (p) => p.team_id === team
          && p.window_kind === kind
          && p.period_end.getTime() < dbNow.getTime()
          && (key === undefined ? p.api_key_id == null : p.api_key_id === key)
          && [...this.reservations.values()].some(
            (r) => r.period_id === p.id && r.status === 'pending' && r.lease_expires_at <= this.now,
          ),
      ).sort((a, b) => a.period_start.getTime() - b.period_start.getTime());
      for (const p of rows) this.lockOrder.push(`period:${p.id}`);
      return { rows, rowCount: null };
    }
    if (sql.startsWith('SELECT p.* FROM budget_period_usage p') && s.includes('JOIN budget_reservations r')) {
      const [requestId] = params as [string];
      const rows = [...this.reservations.values()]
        .filter((r) => r.request_id === requestId)
        .map((r) => this.periods.get(r.period_id))
        .filter((p): p is FakePeriodRow => p != null);
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT id FROM budget_period_usage') && s.includes('FOR UPDATE')) {
      // Two shapes: the resolve path locks ALL team periods (1 param), and the
      // sweep path locks the immediately-preceding period for one window kind
      // (3-4 params, with period_end < $3).
      if (s.includes('period_end <')) {
        const [team, kind, dbNow, key] = params as [string, BudgetWindowKind, Date, string | undefined];
        const rows = [...this.periods.values()].filter(
          (p) => p.team_id === team
            && p.window_kind === kind
            && p.period_end.getTime() < dbNow.getTime()
            && (key === undefined ? p.api_key_id == null : p.api_key_id === key)
            // Mirror prod: only closed periods with reclaimable pending rows
            // are swept (EXISTS predicate), oldest first.
            && [...this.reservations.values()].some(
              (r) => r.period_id === p.id && r.status === 'pending' && r.lease_expires_at <= this.now,
            ),
        ).sort((a, b) => a.period_start.getTime() - b.period_start.getTime());
        for (const p of rows) this.lockOrder.push(`period:${p.id}`);
        return { rows, rowCount: null };
      }
      const team = String(params[0]);
      const rows = [...this.periods.values()].filter((p) => p.team_id === team);
      for (const p of rows) this.lockOrder.push(`period:${p.id}`);
      return { rows, rowCount: null };
    }
    throw new Error(`FakeDb: unhandled SQL:\n${sql}\nparams=${JSON.stringify(params)}`);
  }
}

let db: FakeDb;

function reservationOf(result: Awaited<ReturnType<typeof reserveBudget>>): BudgetReservation {
  if (!result.allowed) throw new Error(`expected allowed, got ${JSON.stringify(result)}`);
  return result.reservation;
}

const est = (microcents: number | null): BudgetEstimate => ({ estimatedMicrocents: microcents });

beforeEach(() => {
  db = new FakeDb();
  testHooks.client = db;
});

describe('reserveBudget', () => {
  it('evaluates the new estimate once before inserting a reservation', async () => {
    db.period('team-a', null, 'daily').reserved_microcents = '40000000';
    db.cap('team-a', null, 'daily', 100_000_000);
    const result = await reserveBudget({
      requestId: 'req-1', teamId: 'team-a', apiKeyId: null,
      estimate: est(60_000_000),
    });
    expect(result.allowed).toBe(true);
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('100000000');
  });

  it('rolls back every scope when one hard window rejects', async () => {
    db.cap('team-a', null, 'daily', 100_000_000);
    db.cap('team-a', 'key-a', 'daily', 100_000_000);
    const result = await reserveBudget({
      requestId: 'req-2', teamId: 'team-a', apiKeyId: 'key-a',
      estimate: est(101_000_000),
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.kind).toBe('exceeded');
    expect(db.reservations.size).toBe(0);
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('0');
    expect(db.period('team-a', 'key-a', 'monthly').reserved_microcents).toBe('0');
  });

  it('admits at exact cap (equality) and rejects above it', async () => {
    db.cap('team-a', null, 'daily', 100_000_000);
    const exact = await reserveBudget({ requestId: 'req-exact', teamId: 'team-a', apiKeyId: null, estimate: est(100_000_000) });
    expect(exact.allowed).toBe(true);
    const over = await reserveBudget({ requestId: 'req-over', teamId: 'team-a', apiKeyId: null, estimate: est(1) });
    expect(over.allowed).toBe(false);
    if (!over.allowed) {
      expect(over.kind).toBe('exceeded');
      expect(over.statusCode).toBe(402);
      expect(over.scope).toBe('team');
      expect(over.window).toBe('daily');
      expect(over.retryAfterSeconds).not.toBeNull();
      expect(over.resetAt).toBeDefined();
    }
  });

  it('keeps team and key scope counters isolated', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    db.cap('team-a', 'key-a', 'daily', 1_000_000_000);
    const keyRes = await reserveBudget({ requestId: 'req-k', teamId: 'team-a', apiKeyId: 'key-a', estimate: est(50_000_000) });
    expect(keyRes.allowed).toBe(true);
    expect(db.period('team-a', 'key-a', 'daily').reserved_microcents).toBe('50000000');
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('50000000');
    // A different team's key sees only its own rows.
    db.cap('team-b', 'key-b', 'daily', 1_000_000_000);
    const other = await reserveBudget({ requestId: 'req-b', teamId: 'team-b', apiKeyId: 'key-b', estimate: est(50_000_000) });
    expect(other.allowed).toBe(true);
    expect(db.period('team-b', 'key-b', 'daily').reserved_microcents).toBe('50000000');
    expect(db.period('team-a', 'key-a', 'daily').reserved_microcents).toBe('50000000');
  });

  it('locks periods team-first then key, daily->weekly->monthly, before reservations', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    db.cap('team-a', null, 'weekly', 1_000_000_000);
    db.cap('team-a', null, 'monthly', 1_000_000_000);
    db.cap('team-a', 'key-a', 'daily', 1_000_000_000);
    db.cap('team-a', 'key-a', 'weekly', 1_000_000_000);
    await reserveBudget({ requestId: 'req-lock', teamId: 'team-a', apiKeyId: 'key-a', estimate: est(10_000_000) });
    const kinds: string[] = [];
    for (const entry of db.lockOrder) {
      // team/key ids: team:key:kind:start; identity ids: team::identity:kind:start
      const match = /^period:team-a:(.*?):(daily|weekly|monthly):/.exec(entry);
      if (match) kinds.push(`${match[1] === '' ? 'team' : match[1]}:${match[2]}`);
    }
    expect(kinds).toEqual([
      'team:daily', 'team:weekly', 'team:monthly',
      'key-a:daily', 'key-a:weekly',
    ]);
    const periodLocks = db.lockOrder.filter((l) => l.startsWith('period:')).length;
    const reservationLocks = db.lockOrder.filter((l) => l.startsWith('reservation:')).length;
    expect(reservationLocks).toBe(0); // no settle/release/resolve touched reservations
    expect(periodLocks).toBeGreaterThan(0);
  });

  it('dedupes by request_id without double incrementing', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const first = await reserveBudget({ requestId: 'req-d', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) });
    expect(first.allowed).toBe(true);
    const second = await reserveBudget({ requestId: 'req-d', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) });
    expect(second.allowed).toBe(true);
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('50000000');
  });

  it('fails closed on a duplicate of a settled request — never admits unreserved', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const first = reservationOf(await reserveBudget({ requestId: 'req-t', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await markBudgetReservationDispatched(first);
    await settleBudgetReservation({ reservation: first, actualMicrocents: 40_000_000, actualCostKnown: true, reasonCode: 'no_dispatch' });
    // A terminal reservation must not admit a re-dispatch: the insert would
    // conflict, so the retry would run unreserved against the cap.
    const dup = await reserveBudget({ requestId: 'req-t', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) });
    expect(dup.allowed).toBe(false);
    if (!dup.allowed) {
      expect(dup.kind).toBe('service_unavailable');
      expect(dup.statusCode).toBe(503);
      expect(dup.message).toContain('Duplicate terminal budget reservation');
    }
  });

  it('enforces a monthly-only per-key cap (key scope covers all windows)', async () => {
    db.cap('team-a', 'key-1', 'monthly', 100_000_000);
    const r1 = reservationOf(await reserveBudget({ requestId: 'req-km1', teamId: 'team-a', apiKeyId: 'key-1', estimate: est(90_000_000) }));
    await markBudgetReservationDispatched(r1);
    await settleBudgetReservation({ reservation: r1, actualMicrocents: 90_000_000, actualCostKnown: true, reasonCode: 'no_dispatch' });
    // 90M committed of a 100M monthly key cap: the next 20M estimate rejects.
    const r2 = await reserveBudget({ requestId: 'req-km2', teamId: 'team-a', apiKeyId: 'key-1', estimate: est(20_000_000) });
    expect(r2.allowed).toBe(false);
    if (!r2.allowed) {
      expect(r2.scope).toBe('key');
      expect(r2.window).toBe('monthly');
    }
  });

  it('alert-only scopes never reject over-cap traffic (reporting-only status)', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000, 'alert');
    // Seed spend so committed is already over the cap before this admission.
    const r1 = reservationOf(await reserveBudget({ requestId: 'req-al1', teamId: 'team-a', apiKeyId: null, estimate: est(900_000_000) }));
    await markBudgetReservationDispatched(r1);
    await settleBudgetReservation({ reservation: r1, actualMicrocents: 900_000_000, actualCostKnown: true, reasonCode: 'no_dispatch' });
    // Over cap now (900M of 1B); alert action must still admit and reserve.
    const r2 = await reserveBudget({ requestId: 'req-al2', teamId: 'team-a', apiKeyId: null, estimate: est(200_000_000) });
    expect(r2.allowed).toBe(true);
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('200000000');
  });

  it('estimate-unavailable rejection names the earliest-resetting window', async () => {
    db.cap('team-a', null, 'daily', 100_000_000);
    db.cap('team-a', null, 'weekly', 100_000_000);
    db.cap('team-a', null, 'monthly', 100_000_000);
    const r = await reserveBudget({ requestId: 'req-sw', teamId: 'team-a', apiKeyId: null, estimate: est(null) });
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.kind).toBe('estimate_unavailable');
      // daily resets first (2026-08-10T00:00:00Z) — earliest reset wins.
      expect(r.window).toBe('daily');
      expect(r.resetAt).toBe('2026-08-10T00:00:00.000Z');
    }
  });

  it('reserves against exactly one period per window across a reset boundary', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const before = await reserveBudget({ requestId: 'req-day1', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(before.allowed).toBe(true);
    db.advance(24 * 3600_000); // next UTC day
    const after = await reserveBudget({ requestId: 'req-day2', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(after.allowed).toBe(true);
    const day1 = db.period('team-a', null, 'daily');
    const day2Id = db.periods.get(`team-a::daily:${new Date('2026-08-10T00:00:00.000Z').toISOString()}`);
    expect(day1.reserved_microcents).toBe('10000000');
    expect(day2Id?.reserved_microcents).toBe('10000000');
  });

  it('seeds known spend from request_logs on first admission and never double-counts', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    db.log({ id: 'log-1', team_id: 'team-a', timestamp: new Date('2026-08-09T08:00:00Z'), actual_cost_microcents: '20000000', actual_cost_known: true });
    db.log({ id: 'log-2', team_id: 'team-a', timestamp: new Date('2026-08-09T09:00:00Z'), actual_cost_microcents: '5000000', actual_cost_known: false });
    await reserveBudget({ requestId: 'req-s1', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    const period = db.period('team-a', null, 'daily');
    expect(period.actual_microcents).toBe('25000000');
    expect(period.unknown_cost_requests).toBe('1');
    // Second admission (new request) must not re-seed the same logs.
    await reserveBudget({ requestId: 'req-s2', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(period.actual_microcents).toBe('25000000');
    expect(period.unknown_cost_requests).toBe('1');
    // A late log write inside the lookback window is incorporated once.
    db.log({ id: 'log-3', team_id: 'team-a', timestamp: new Date('2026-08-09T10:00:00Z'), actual_cost_microcents: '1000000', actual_cost_known: true });
    await reserveBudget({ requestId: 'req-s3', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(period.actual_microcents).toBe('26000000');
  });

  it('seeds the team scope from ALL key-attributed request_logs', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    db.log({ id: 'log-k1', team_id: 'team-a', api_key_id: 'key-1', timestamp: new Date('2026-08-09T07:00:00Z'), actual_cost_microcents: '30000000', actual_cost_known: true });
    db.log({ id: 'log-k2', team_id: 'team-a', api_key_id: 'key-2', timestamp: new Date('2026-08-09T08:00:00Z'), actual_cost_microcents: '4000000', actual_cost_known: true });
    db.log({ id: 'log-nk', team_id: 'team-a', api_key_id: null, timestamp: new Date('2026-08-09T08:30:00Z'), actual_cost_microcents: '1000000', actual_cost_known: true });
    await reserveBudget({ requestId: 'req-sk1', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    // 30M + 4M + 1M — team scope counts key-attributed AND keyless spend.
    expect(db.period('team-a', null, 'daily').actual_microcents).toBe('35000000');
  });

  it('never re-seeds a settled reservation log into the period (no double-count)', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-dc1', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await markBudgetReservationDispatched(r);
    // The log row lands after the stream, matching the reservation request id.
    db.log({ id: 'req-dc1', team_id: 'team-a', timestamp: new Date('2026-08-09T10:00:00Z'), actual_cost_microcents: '50000000', actual_cost_known: true });
    await settleBudgetReservation({ reservation: r, actualMicrocents: 50_000_000, actualCostKnown: true, reasonCode: 'no_dispatch' });
    // A later admission seeds the period; the settled request must NOT be
    // re-added to actual (it was already booked via settlement).
    await reserveBudget({ requestId: 'req-dc2', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    const period = db.period('team-a', null, 'daily');
    expect(period.actual_microcents).toBe('50000000');
    expect(period.reserved_microcents).toBe('10000000');
  });

  it('re-seeds a released reservation late log (nothing was booked)', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-rl3', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await releaseBudgetReservation(r, 'no_dispatch');
    db.log({ id: 'req-rl3', team_id: 'team-a', timestamp: new Date('2026-08-09T10:00:00Z'), actual_cost_microcents: '50000000', actual_cost_known: true });
    await reserveBudget({ requestId: 'req-rl4', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    // Released = refunded; the real late log is attributed by seeding.
    const period = db.period('team-a', null, 'daily');
    expect(period.actual_microcents).toBe('50000000');
  });

  it('never seeds request_logs from before the period start (lookback clamp)', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    db.log({ id: 'log-old', team_id: 'team-a', timestamp: new Date('2026-08-08T23:59:30Z'), actual_cost_microcents: '999000000', actual_cost_known: true });
    await reserveBudget({ requestId: 'req-so1', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(db.period('team-a', null, 'daily').actual_microcents).toBe('0');
  });

  it('fails closed on hard cap with unresolved unbounded unknown, but admits bounded holds', async () => {
    db.cap('team-a', null, 'daily', 100_000_000, 'block');
    db.addReservation({ period_id: db.period('team-a', null, 'daily').id, request_id: 'req-u', team_id: 'team-a', status: 'unknown_held', estimated_microcents: '0', unknown_held_microcents: '0', known_lower_bound_microcents: '0' });
    const blocked = await reserveBudget({ requestId: 'req-new', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.kind).toBe('estimate_unavailable');
      expect(blocked.statusCode).toBe(503);
    }
    // Bounded unknown hold (estimate > 0) never gates by itself.
    const boundedDb = new FakeDb();
    testHooks.client = boundedDb;
    boundedDb.cap('team-a', null, 'daily', 100_000_000, 'block');
    boundedDb.addReservation({ period_id: boundedDb.period('team-a', null, 'daily').id, request_id: 'req-b1', team_id: 'team-a', status: 'unknown_held', estimated_microcents: '50000000', unknown_held_microcents: '50000000', known_lower_bound_microcents: '0' });
    const admitted = await reserveBudget({ requestId: 'req-b2', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(admitted.allowed).toBe(true);
  });

  it('gates on unresolved seed rows and on in-flight estimate_unavailable rows', async () => {
    db.cap('team-a', null, 'daily', 100_000_000, 'throttle');
    db.log({ id: 'log-seed', team_id: 'team-a', timestamp: new Date('2026-08-09T08:00:00Z'), actual_cost_microcents: '5000000', actual_cost_known: false });
    const first = await reserveBudget({ requestId: 'req-g1', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(first.allowed).toBe(false);
    if (!first.allowed) expect(first.kind).toBe('estimate_unavailable');

    const gateDb = new FakeDb();
    testHooks.client = gateDb;
    gateDb.cap('team-a', null, 'daily', 100_000_000, 'throttle');
    gateDb.addReservation({ period_id: gateDb.period('team-a', null, 'daily').id, request_id: 'req-g2', team_id: 'team-a', estimate_unavailable: true, estimated_microcents: '0' });
    const second = await reserveBudget({ requestId: 'req-g3', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    expect(second.allowed).toBe(false);
    if (!second.allowed) expect(second.kind).toBe('estimate_unavailable');
  });

  it('admits alert-only unknown pricing with a warning and no reserved amount', async () => {
    db.cap('team-a', null, 'daily', 100_000_000, 'alert');
    const result = await reserveBudget({ requestId: 'req-alert', teamId: 'team-a', apiKeyId: null, estimate: { estimatedMicrocents: null, missingPricing: { provider: 'p', model: 'm' } } });
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.warnings).toContain('unknown_pricing');
      expect(result.reservation.estimatedMicrocents).toBe(0);
      expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('0');
    }
  });

  it('rejects unknown pricing under a hard cap with 503 estimate_unavailable', async () => {
    db.cap('team-a', null, 'daily', 100_000_000, 'block');
    const result = await reserveBudget({ requestId: 'req-hard', teamId: 'team-a', apiKeyId: null, estimate: { estimatedMicrocents: null, missingPricing: { provider: 'p', model: 'm' } } });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.kind).toBe('estimate_unavailable');
      expect(result.statusCode).toBe(503);
    }
  });

  it('keeps legacy monthly-only codes when only the monthly cap is configured', async () => {
    db.cap('team-a', null, 'monthly', 100_000_000, 'block');
    const over = await reserveBudget({ requestId: 'req-m1', teamId: 'team-a', apiKeyId: null, estimate: est(101_000_000) });
    expect(over.allowed).toBe(false);
    if (!over.allowed) {
      expect(over.kind).toBe('exceeded');
      expect(over.window).toBe('monthly');
      expect(over.scope).toBe('team');
      expect(over.statusCode).toBe(402);
    }
    const throttleDb = new FakeDb();
    testHooks.client = throttleDb;
    throttleDb.cap('team-a', null, 'monthly', 100_000_000, 'throttle');
    const throttled = await reserveBudget({ requestId: 'req-m2', teamId: 'team-a', apiKeyId: null, estimate: est(101_000_000) });
    expect(throttled.allowed).toBe(false);
    if (!throttled.allowed) expect(throttled.statusCode).toBe(429);
  });
});

describe('lease lifecycle', () => {
  it('reclaims expired undispatched leases as released and returns the reserved amount', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-l1', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('50000000');
    db.advance(601_000);
    await reserveBudget({ requestId: 'req-l2', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    const period = db.period('team-a', null, 'daily');
    expect(period.reserved_microcents).toBe('10000000');
    expect(db.reservations.get(`team-a::daily:2026-08-09T00:00:00.000Z:req-l1`)?.status).toBe('released');
    void r;
  });

  it('converts expired dispatched leases to unknown_held, never releases them', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-c1', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await markBudgetReservationDispatched(r);
    db.advance(601_000);
    await reserveBudget({ requestId: 'req-c2', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    const period = db.period('team-a', null, 'daily');
    expect(period.unknown_held_microcents).toBe('50000000');
    expect(period.unknown_cost_requests).toBe('1');
    const row = db.reservations.get(`team-a::daily:2026-08-09T00:00:00.000Z:req-c1`)!;
    expect(row.status).toBe('unknown_held');
    expect(row.known_lower_bound_microcents).toBe('0');
  });

  it('sweeps stranded rows in windows whose caps were removed', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    db.cap('team-a', null, 'monthly', 1_000_000_000);
    const before = await reserveBudget({ requestId: 'req-or1', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) });
    expect(before.allowed).toBe(true);
    // Cross midnight, expire the lease, and REMOVE the daily cap (monthly stays).
    db.advance(24 * 3600_000 + 601_000);
    db.cap('team-a', null, 'daily', null);
    await reserveBudget({ requestId: 'req-or2', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    // The orphaned daily row is reclaimed even though daily is no longer capped.
    const orphan = db.reservations.get(`team-a::daily:2026-08-09T00:00:00.000Z:req-or1`);
    expect(orphan?.status).toBe('released');
  });

  it('sweeps expired leases from the immediately closed period after a reset', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const before = await reserveBudget({ requestId: 'req-prev', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) });
    expect(before.allowed).toBe(true);
    // Cross the UTC midnight boundary AND expire the lease (600s default).
    db.advance(24 * 3600_000 + 601_000);
    await reserveBudget({ requestId: 'req-now', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    // The closed period's pending row was swept by the new admission.
    const prev = db.reservations.get(`team-a::daily:2026-08-09T00:00:00.000Z:req-prev`);
    expect(prev?.status).toBe('released');
    // The closed period's reserved was returned.
    const closed = db.periods.get(`team-a::daily:2026-08-09T00:00:00.000Z`);
    expect(closed?.reserved_microcents).toBe('0');
  });

  it('fences dispatch after reclamation', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-f1', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) }));
    db.advance(601_000);
    const mark = await markBudgetReservationDispatched(r);
    expect(mark.marked).toBe(false);
    expect(mark.alreadyMarked).toBe(false);
  });

  it('reports alreadyMarked for a live dispatched row', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-m', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) }));
    const first = await markBudgetReservationDispatched(r);
    expect(first.marked).toBe(true);
    const second = await markBudgetReservationDispatched(r);
    expect(second.marked).toBe(false);
    expect(second.alreadyMarked).toBe(true);
  });

  it('refreshes a live lease and refuses to refresh an expired one', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-r', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) }));
    await markBudgetReservationDispatched(r);
    const live = await refreshBudgetReservationLease(r);
    expect(live.refreshed).toBe(true);
    db.advance(601_000);
    const stale = await refreshBudgetReservationLease(r);
    expect(stale.refreshed).toBe(false);
  });
});

describe('settlement', () => {
  it('drains reserved exactly once on known settlement', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-st1', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await settleBudgetReservation({ reservation: r, actualMicrocents: 40_000_000, actualCostKnown: true, reasonCode: 'no_dispatch' });
    const period = db.period('team-a', null, 'daily');
    expect(period.reserved_microcents).toBe('0');
    expect(period.actual_microcents).toBe('40000000');
    // Repeat is a no-op.
    await settleBudgetReservation({ reservation: r, actualMicrocents: 40_000_000, actualCostKnown: true, reasonCode: 'no_dispatch' });
    expect(period.actual_microcents).toBe('40000000');
  });

  it('moves estimate minus lower bound into held on unknown settlement', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-st2', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await settleBudgetReservation({ reservation: r, actualMicrocents: 20_000_000, actualCostKnown: false, reasonCode: 'upstream_unknown' });
    const period = db.period('team-a', null, 'daily');
    expect(period.reserved_microcents).toBe('0');
    expect(period.actual_microcents).toBe('20000000');
    expect(period.unknown_held_microcents).toBe('30000000');
    expect(period.unknown_cost_requests).toBe('1');
    // Unknown settle against the unknown_held row is an idempotent no-op.
    await settleBudgetReservation({ reservation: r, actualMicrocents: 99_000_000, actualCostKnown: false, reasonCode: 'upstream_unknown' });
    expect(period.unknown_held_microcents).toBe('30000000');
  });

  it('reconciles inline when a known cost arrives for an unknown_held row', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-st3', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await settleBudgetReservation({ reservation: r, actualMicrocents: 20_000_000, actualCostKnown: false, reasonCode: 'upstream_unknown' });
    await settleBudgetReservation({ reservation: r, actualMicrocents: 45_000_000, actualCostKnown: true, reasonCode: 'concurrent' });
    const period = db.period('team-a', null, 'daily');
    expect(period.actual_microcents).toBe('45000000');
    expect(period.unknown_held_microcents).toBe('0');
    expect(period.unknown_cost_requests).toBe('0');
  });

  it('rejects a known settle below the recorded lower bound', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-st4', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await settleBudgetReservation({ reservation: r, actualMicrocents: 20_000_000, actualCostKnown: false, reasonCode: 'upstream_unknown' });
    await expect(
      settleBudgetReservation({ reservation: r, actualMicrocents: 10_000_000, actualCostKnown: true, reasonCode: 'concurrent' }),
    ).rejects.toThrow('below recorded lower bound');
  });

  it('release only touches pending rows', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-rl', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await releaseBudgetReservation(r, 'no_dispatch');
    const period = db.period('team-a', null, 'daily');
    expect(period.reserved_microcents).toBe('0');
    // Second release no-ops.
    await releaseBudgetReservation(r, 'no_dispatch');
    expect(period.reserved_microcents).toBe('0');
    expect(period.actual_microcents).toBe('0');
  });

  it('never releases a dispatched row — only settlement or reclamation may terminate it', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-rl2', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    const marked = await markBudgetReservationDispatched(r);
    expect(marked.marked).toBe(true);
    // A release attempt on the dispatched row must no-op at the ledger level.
    await releaseBudgetReservation(r, 'no_dispatch');
    const period = db.period('team-a', null, 'daily');
    expect(period.reserved_microcents).toBe('50000000');
    // The dispatched row still settles normally.
    await settleBudgetReservation({ reservation: r, actualMicrocents: 50_000_000, actualCostKnown: true, reasonCode: 'concurrent' });
    expect(period.reserved_microcents).toBe('0');
    expect(period.actual_microcents).toBe('50000000');
  });
});

  it('blocks adjustment on a scope frozen by an unresolved unbounded unknown', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-au1', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    // Freeze the scope with an unbounded unknown (estimate 0, held > 0).
    db.addReservation({ period_id: db.period('team-a', null, 'daily').id, request_id: 'req-ub', team_id: 'team-a', status: 'unknown_held', estimated_microcents: '0', unknown_held_microcents: '1000000', known_lower_bound_microcents: '0' });
    const adj = await adjustBudgetReservation({ reservation: r, estimate: est(90_000_000) });
    expect(adj.allowed).toBe(false);
    if (!adj.allowed) {
      expect(adj.kind).toBe('estimate_unavailable');
      expect(adj.statusCode).toBe(503);
    }
  });

describe('adjustBudgetReservation', () => {
  it('grows the reservation when the adjusted estimate rises within cap', async () => {
    db.cap('team-a', null, 'daily', 100_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-a1', teamId: 'team-a', apiKeyId: null, estimate: est(40_000_000) }));
    const adjusted = await adjustBudgetReservation({ reservation: r, estimate: est(60_000_000) });
        expect(adjusted.allowed).toBe(true);
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('60000000');
  });

  it('rejects an upward adjustment past the cap without mutating anything', async () => {
    db.cap('team-a', null, 'daily', 100_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-a2', teamId: 'team-a', apiKeyId: null, estimate: est(40_000_000) }));
    const adjusted = await adjustBudgetReservation({ reservation: r, estimate: est(110_000_000) });
    expect(adjusted.allowed).toBe(false);
    if (!adjusted.allowed) expect(adjusted.kind).toBe('exceeded');
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('40000000');
    expect(db.reservations.get(`team-a::daily:2026-08-09T00:00:00.000Z:req-a2`)?.estimated_microcents).toBe('40000000');
  });

  it('never retro-rejects a non-positive delta', async () => {
    db.cap('team-a', null, 'daily', 100_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-a3', teamId: 'team-a', apiKeyId: null, estimate: est(100_000_000) }));
    const adjusted = await adjustBudgetReservation({ reservation: r, estimate: est(60_000_000) });
        expect(adjusted.allowed).toBe(true);
    expect(db.period('team-a', null, 'daily').reserved_microcents).toBe('60000000');
  });

  it('fails closed on a reclaimed lease', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-a4', teamId: 'team-a', apiKeyId: null, estimate: est(40_000_000) }));
    db.advance(601_000);
    const adjusted = await adjustBudgetReservation({ reservation: r, estimate: est(60_000_000) });
    expect(adjusted.allowed).toBe(false);
    if (!adjusted.allowed) {
      expect(adjusted.kind).toBe('service_unavailable');
      expect(adjusted.statusCode).toBe(503);
    }
  });

  it('retains the stored estimate when the adjusted estimate is unavailable', async () => {
    db.cap('team-a', null, 'daily', 100_000_000, 'alert');
    const r = reservationOf(await reserveBudget({ requestId: 'req-a5', teamId: 'team-a', apiKeyId: null, estimate: { estimatedMicrocents: null, missingPricing: { provider: 'p', model: 'm' } } }));
    const adjusted = await adjustBudgetReservation({ reservation: r, estimate: { estimatedMicrocents: null, missingPricing: { provider: 'p', model: 'm' } } });
    expect(adjusted.allowed).toBe(true);
    expect(db.reservations.get(`team-a::daily:2026-08-09T00:00:00.000Z:req-a5`)?.estimated_microcents).toBe('0');
  });
});

describe('resolveBudgetUnknownReservation', () => {
  async function unknownHeldReservation(estimate = 50_000_000, lowerBound = 20_000_000) {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = await reserveBudget({ requestId: 'req-x', teamId: 'team-a', apiKeyId: null, estimate: est(estimate) });
    if (!r.allowed) throw new Error('admission failed');
    await settleBudgetReservation({ reservation: r.reservation, actualMicrocents: lowerBound, actualCostKnown: false, reasonCode: 'upstream_unknown' });
    return r.reservation;
  }

  it('adds confirmed minus lower bound and releases the held remainder', async () => {
    await unknownHeldReservation();
    const result = await resolveBudgetUnknownReservation({
      teamId: 'team-a', requestId: 'req-x', confirmedRawCostMicrocents: 45_000_000,
      evidence: 'provider invoice', note: 'reconciled', resolvedBy: 'ops',
    });
    expect(result).toEqual({ alreadyResolved: false, actualAddedMicrocents: 25_000_000, releasedMicrocents: 30_000_000 });
    const period = db.period('team-a', null, 'daily');
    expect(period.actual_microcents).toBe('45000000');
    expect(period.unknown_held_microcents).toBe('0');
    expect(period.unknown_cost_requests).toBe('0');
  });

  it('is idempotent on repeat resolution', async () => {
    await unknownHeldReservation();
    await resolveBudgetUnknownReservation({ teamId: 'team-a', requestId: 'req-x', confirmedRawCostMicrocents: 45_000_000, evidence: 'e', note: 'n', resolvedBy: 'ops' });
    const second = await resolveBudgetUnknownReservation({ teamId: 'team-a', requestId: 'req-x', confirmedRawCostMicrocents: 45_000_000, evidence: 'e', note: 'n', resolvedBy: 'ops' });
    expect(second.alreadyResolved).toBe(true);
    expect(second.actualAddedMicrocents).toBe(0);
  });

  it('rejects confirmed below the stored lower bound', async () => {
    await unknownHeldReservation();
    await expect(
      resolveBudgetUnknownReservation({ teamId: 'team-a', requestId: 'req-x', confirmedRawCostMicrocents: 19_000_000, evidence: 'e', note: 'n', resolvedBy: 'ops' }),
    ).rejects.toThrow('below recorded lower bound');
  });

  it('adds exactly confirmed minus seeded lower bound on seed-ledger resolution', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    db.log({ id: 'log-seed2', team_id: 'team-a', timestamp: new Date('2026-08-09T08:00:00Z'), actual_cost_microcents: '200000000', actual_cost_known: false }); // $2 lower bound
    await reserveBudget({ requestId: 'req-y', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    const period = db.period('team-a', null, 'daily');
    expect(period.actual_microcents).toBe('200000000');
    expect(period.unknown_cost_requests).toBe('1');
    const result = await resolveBudgetUnknownReservation({
      teamId: 'team-a', requestId: 'log-seed2', confirmedRawCostMicrocents: 5_000_000_000, // $50
      evidence: 'provider invoice', note: 'reconciled', resolvedBy: 'ops',
    });
    expect(result.actualAddedMicrocents).toBe(4_800_000_000);
    expect(period.actual_microcents).toBe('5000000000');
    expect(period.unknown_cost_requests).toBe('0');
    // The stored seed amount is immutable.
    expect(db.seeds.get(`team-a::daily:2026-08-09T00:00:00.000Z:log-seed2`)?.actual_microcents).toBe('200000000');
  });

  it('refuses to resolve a seeded unknown below its recorded lower bound', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    db.log({ id: 'log-seed3', team_id: 'team-a', timestamp: new Date('2026-08-09T08:00:00Z'), actual_cost_microcents: '800000000', actual_cost_known: false }); // $8 lower bound
    await reserveBudget({ requestId: 'req-y2', teamId: 'team-a', apiKeyId: null, estimate: est(10_000_000) });
    await expect(resolveBudgetUnknownReservation({
      teamId: 'team-a', requestId: 'log-seed3', confirmedRawCostMicrocents: 300_000_000, // $3 < $8 bound
      evidence: 'provider invoice', note: 'reconciled', resolvedBy: 'ops',
    })).rejects.toThrow('below recorded seed lower bound');
    const period = db.period('team-a', null, 'daily');
    // Nothing was mutated: the overstated aggregate stays pending reconciliation.
    expect(period.actual_microcents).toBe('800000000');
    expect(period.unknown_cost_requests).toBe('1');
  });
});

describe('getBudgetReport', () => {
  it('reports committed arithmetic and qualification through the shared serializer', async () => {
    db.cap('team-a', null, 'daily', 100_000_000, 'alert', 80);
    db.cap('team-a', null, 'monthly', 1_000_000_000, 'block', 80);
    const r = reservationOf(await reserveBudget({ requestId: 'req-rp', teamId: 'team-a', apiKeyId: null, estimate: est(60_000_000) }));
    await settleBudgetReservation({ reservation: r, actualMicrocents: 10_000_000, actualCostKnown: true, reasonCode: 'no_dispatch' });
    const report = await getBudgetReport('team-a', null);
    const daily = report.windows.find((w) => w.kind === 'daily')!;
    expect(daily.actualMicrocents).toBe(10_000_000);
    expect(daily.committedMicrocents).toBe(10_000_000);
    expect(daily.status).toBe('ok');
    expect(report.actualCostsQualified).toBe(true);
    const monthly = report.windows.find((w) => w.kind === 'monthly')!;
    expect(monthly.capMicrocents).toBe(1_000_000_000);
    expect(monthly.periodStart).toBe('2026-08-01T00:00:00.000Z');
  });

  it('flags unknown cost as unqualified', async () => {
    db.cap('team-a', null, 'daily', 1_000_000_000);
    const r = reservationOf(await reserveBudget({ requestId: 'req-rq', teamId: 'team-a', apiKeyId: null, estimate: est(50_000_000) }));
    await settleBudgetReservation({ reservation: r, actualMicrocents: 10_000_000, actualCostKnown: false, reasonCode: 'upstream_unknown' });
    const report = await getBudgetReport('team-a', null);
    expect(report.actualCostsQualified).toBe(false);
    expect(report.windows.find((w) => w.kind === 'daily')?.unknownCostRequests).toBe(1);
  });
});

describe('identity scope (RSH-140)', () => {
  it('enforces an identity cap between the team and key scopes', async () => {
    const idb = new FakeDb();
    testHooks.client = idb;
    idb.cap('team-a', null, 'daily', 1_000_000_000); // team: generous
    idb.capIdentity('team-a', 'person-1', 'daily', 100_000_000); // identity: 100M microcents
    idb.cap('team-a', 'key-1', 'daily', 1_000_000_000); // key: generous
    const r = await reserveBudget({
      requestId: 'req-i1', teamId: 'team-a', apiKeyId: 'key-1', identityId: 'person-1', estimate: est(150_000_000),
    });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.scope).toBe('identity');
  });

  it('passes when the identity cap is not exceeded (all three scopes admit)', async () => {
    const idb = new FakeDb();
    testHooks.client = idb;
    idb.cap('team-a', null, 'daily', 1_000_000_000);
    idb.capIdentity('team-a', 'person-1', 'daily', 100_000_000);
    idb.cap('team-a', 'key-1', 'daily', 1_000_000_000);
    const r = await reserveBudget({
      requestId: 'req-i2', teamId: 'team-a', apiKeyId: 'key-1', identityId: 'person-1', estimate: est(50_000_000),
    });
    expect(r.allowed).toBe(true);
    // ALL THREE scopes reserved: team, identity, key (each period row carries
    // the 50M reservation)
    expect(idb.period('team-a', null, 'daily').reserved_microcents).toBe('50000000');
    expect(idb.period('team-a', null, 'daily', 'person-1').reserved_microcents).toBe('50000000');
    expect(idb.period('team-a', 'key-1', 'daily').reserved_microcents).toBe('50000000');
    expect([...idb.reservations.values()].map((r2) => `${r2.period_id}:${r2.api_key_id ?? ''}:${r2.identity_id ?? ''}`))
      .toEqual(expect.arrayContaining([
        'team-a::daily:2026-08-09T00:00:00.000Z::',
        'team-a::person-1:daily:2026-08-09T00:00:00.000Z::person-1',
        'team-a:key-1:daily:2026-08-09T00:00:00.000Z:key-1:',
      ]));
  });

  it('locks identity periods in the canonical team < identity < key order', async () => {
    const idb = new FakeDb();
    testHooks.client = idb;
    idb.cap('team-a', null, 'daily', 1_000_000_000);
    idb.capIdentity('team-a', 'person-1', 'daily', 1_000_000_000);
    idb.cap('team-a', 'key-1', 'daily', 1_000_000_000);
    await reserveBudget({ requestId: 'req-i3', teamId: 'team-a', apiKeyId: 'key-1', identityId: 'person-1', estimate: est(10_000_000) });
    const kinds: string[] = [];
    for (const entry of idb.lockOrder) {
      // team: ''; identity: ':person-1' (colons stripped); key: 'key-1'
      const match = /^period:team-a:(.*?):daily:/.exec(entry);
      if (match) kinds.push(match[1] === '' ? 'team' : match[1].replace(/^:+/, ''));
    }
    expect(kinds.slice(0, 3)).toEqual(['team', 'person-1', 'key-1']);
  });

  it('seeds identity-scoped period rows only from that identity\'s request logs', async () => {
    const idb = new FakeDb();
    testHooks.client = idb;
    idb.capIdentity('team-a', 'person-2', 'daily', 1_000_000_000);
    idb.log({ id: 'log-p1', team_id: 'team-a', layer_identity_id: 'person-1', timestamp: new Date('2026-08-09T08:00:00Z'), actual_cost_microcents: '20000000', actual_cost_known: true });
    idb.log({ id: 'log-p2', team_id: 'team-a', layer_identity_id: 'person-2', timestamp: new Date('2026-08-09T09:00:00Z'), actual_cost_microcents: '50000000', actual_cost_known: true });
    // Admission for person-2 seeds the identity period; person-1's logs must NOT count
    const r = await reserveBudget({ requestId: 'req-i4', teamId: 'team-a', apiKeyId: null, identityId: 'person-2', estimate: est(10_000_000) });
    expect(r.allowed).toBe(true);
    const period = idb.period('team-a', null, 'daily', 'person-2');
    expect(period.actual_microcents).toBe('50000000');
    expect(period.seeded_request_count).toBe(1);
  });

  it('reports identity windows in getBudgetReport', async () => {
    const idb = new FakeDb();
    testHooks.client = idb;
    idb.capIdentity('team-a', 'person-1', 'daily', 100_000_000);
    await reserveBudget({ requestId: 'req-i5', teamId: 'team-a', apiKeyId: null, identityId: 'person-1', estimate: est(40_000_000) });
    const report = await getBudgetReport('team-a', null, undefined, 'person-1');
    // the report exposes the ACTIVE scope's windows — with only an identity
    // cap configured, the active scope IS the identity scope
    const daily = report.windows.find((w) => w.kind === 'daily');
    expect(daily?.capMicrocents).toBe(100_000_000);
    expect(daily?.reservedMicrocents).toBe(40_000_000); // the reservation, not settled spend
  });

  it('keeps the residual ledger when a cap is removed after accrual (no-cap kind, real spend)', async () => {
    // A cap removed after spend leaves period rows with committed usage; the
    // report must keep rendering 'no cap' WITH the ledger (mirrors the
    // dashboard by-key surface), not an empty window. The fully-uncapped
    // team has no period-row namespace and reports nothing — the divergence
    // case is a kind whose cap is removed while other caps remain.
    const idb = new FakeDb();
    testHooks.client = idb;
    idb.cap('team-a', null, 'daily', 100_000_000);
    idb.cap('team-a', null, 'weekly', 500_000_000);
    const r = await reserveBudget({ requestId: 'req-res', teamId: 'team-a', apiKeyId: null, estimate: est(30_000_000) });
    expect(r.allowed).toBe(true);
    await settleBudgetReservation({ reservation: reservationOf(r), actualMicrocents: 25_000_000, actualCostKnown: true, reasonCode: 'no_dispatch' });
    idb.cap('team-a', null, 'daily', null); // daily cap removed after accrual; weekly remains

    const report = await getBudgetReport('team-a', null);
    const daily = report.windows.find((w) => w.kind === 'daily');
    expect(daily?.capMicrocents).toBeNull();
    expect(daily?.actualMicrocents).toBe(25_000_000); // residual spend still visible
  });
});
