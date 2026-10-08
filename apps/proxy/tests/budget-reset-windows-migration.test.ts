import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../src/db/migrations/061-budget-reset-windows.sql', import.meta.url),
  'utf8',
);

describe('061 budget reset windows migration', () => {
  it('adds the four configuration columns as numeric(20,8) with quantization checks', () => {
    expect(migration).toContain('ALTER TABLE team_budgets');
    expect(migration).toContain('daily_usd_cap numeric(20,8)');
    expect(migration).toContain('weekly_usd_cap numeric(20,8)');
    expect(migration).toContain('ALTER TABLE api_keys');
    expect(migration).toContain('daily_usd_cap = trunc(daily_usd_cap, 8)');
    expect(migration).toContain('weekly_usd_cap = trunc(weekly_usd_cap, 8)');
  });

  it('keeps tenant ids as TEXT scoped to the existing teams/api_keys relations', () => {
    expect(migration).toContain('team_id TEXT REFERENCES teams(id)');
    expect(migration).toContain('api_key_id TEXT REFERENCES api_keys(id) ON DELETE NO ACTION');
    expect(migration).not.toContain('uuid');
  });

  it('creates budget_period_usage with all three windows and non-negative BIGINT counters', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS budget_period_usage');
    expect(migration).toContain("window_kind IN ('daily', 'weekly', 'monthly')");
    expect(migration).toContain('reserved_microcents BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('unknown_held_microcents BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('actual_microcents BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('unknown_cost_requests BIGINT NOT NULL DEFAULT 0');
    expect(migration).toContain('period_start TIMESTAMPTZ NOT NULL');
    expect(migration).toContain('period_end TIMESTAMPTZ NOT NULL');
    expect(migration).toContain('seeded_through TIMESTAMPTZ');
    // The relational held <= reserved period-level check is forbidden.
    expect(migration).not.toMatch(/unknown_held_microcents\s*<=\s*reserved_microcents|reserved_microcents\s*>=\s*unknown_held_microcents/);
  });

  it('pins both exact partial unique indexes for team and key scopes', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_usage_team_unique\s+ON budget_period_usage \(team_id, window_kind, period_start\)\s+WHERE api_key_id IS NULL/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_usage_key_unique\s+ON budget_period_usage \(team_id, api_key_id, window_kind, period_start\)\s+WHERE api_key_id IS NOT NULL/);
  });

  it('creates budget_reservations with per-row money bounds and lifecycle columns', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS budget_reservations');
    expect(migration).toContain('id TEXT PRIMARY KEY');
    expect(migration).toContain('period_id TEXT REFERENCES budget_period_usage(id)');
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_reservations_period_request\s+ON budget_reservations \(period_id, request_id\)/);
    expect(migration).toContain("status IN ('pending', 'settled', 'released', 'unknown_held')");
    expect(migration).toContain('unknown_held_microcents <= estimated_microcents');
    expect(migration).toContain('known_lower_bound_microcents BIGINT');
    expect(migration).toContain('estimate_unavailable BOOLEAN NOT NULL DEFAULT false');
    expect(migration).toContain('lease_expires_at TIMESTAMPTZ NOT NULL');
    expect(migration).toContain('dispatched_at TIMESTAMPTZ');
    expect(migration).toContain('estimated_microcents >= 0');
    expect(migration).toContain('actual_microcents >= 0');
    expect(migration).toContain('unknown_held_microcents >= 0');
  });

  it('creates the seed dedup ledger with known_cost marker and both indexes', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS budget_period_seeded_requests');
    expect(migration).toContain('known_cost BOOLEAN NOT NULL');
    expect(migration).toContain('PRIMARY KEY (period_id, request_id)');
    expect(migration).toContain('budget_period_seeded_requests (request_id, period_id)');
    expect(migration).toContain('budget_reservations (request_id, period_id)');
  });

  it('installs the scope-match, key-ownership, and immutable-period triggers', () => {
    expect(migration).toContain('budget_reservation_scope_matches_period');
    expect(migration).toContain('budget_period_key_belongs_to_team');
    expect(migration).toContain('budget_period_identity_immutable');
  });

  it('uses TIMESTAMPTZ for every persisted instant', () => {
    expect(migration).not.toMatch(/\btimestamp\b(?!\s+with\s+time\s+zone)/i);
    expect(migration).not.toContain('SET TIME ZONE');
  });
});

describe('seed/release lifecycle SQL shapes (RSH-138 review hardening)', () => {
  it('seeds team spend with a single nullable key param — never an unreferenced $3', () => {
    const service = readFileSync(
      new URL('../src/billing/budget-reservations.ts', import.meta.url),
      'utf8',
    );
    // The team-scope seed statement previously bound $3 without referencing it
    // (Postgres parse error on every capped admission); it must now use the
    // nullable-key form and count ALL team logs.
    expect(service).toContain('($3::text IS NULL OR rl.api_key_id = $3)');
    expect(service).not.toContain('AND rl.api_key_id IS NULL');
    // Booked rows (pending/settled/unknown_held) must block re-seeding;
    // only released rows (nothing booked) allow the late log to be attributed.
    expect(service).toContain("AND r.status <> 'released'");
    // Re-seeding must never reach before the period start.
    expect(service).toContain('Math.max(rawLookback.getTime(), period.period_start.getTime())');
  });

  it('fences release against dispatched rows at the ledger level', () => {
    const service = readFileSync(
      new URL('../src/billing/budget-reservations.ts', import.meta.url),
      'utf8',
    );
    expect(service).toContain("status = 'pending' AND dispatched_at IS NULL");
  });
});
