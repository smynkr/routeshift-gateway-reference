import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { closePool, getPool } from '../src/db/pool.js';
import { assertPostgresBudgetLedgerSchema } from '../src/db/postgres-schema-guard.js';

// Integration coverage for the budget-ledger startup guard: the LIKE/regex
// patterns match pg catalog renderings (pg_get_expr / pg_get_indexdef /
// pg_get_functiondef / format_type), which mocked unit tests cannot exercise.
// Gated on TEST_DATABASE_URL so CI without a Postgres stays green; when set,
// migrations 001-065 are applied (idempotent) and drift mutations must fail
// the guard while a correct catalog passes. Static imports are safe: the
// pool is created lazily on the first getPool() call, which happens in
// beforeAll after DATABASE_URL is set.
const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)('assertPostgresBudgetLedgerSchema (integration)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    await runMigrations();
  }, 120_000);

  afterAll(async () => {
    await closePool();
  });

  it('passes on a database with migrations 001-065 applied', async () => {
    await expect(assertPostgresBudgetLedgerSchema()).resolves.toBeUndefined();
  });

  it('rejects when the single-scope trigger is disabled (tgenabled drift)', async () => {
    await getPool().query('ALTER TABLE budget_period_usage DISABLE TRIGGER budget_period_single_scope_trigger');
    try {
      await expect(assertPostgresBudgetLedgerSchema()).rejects.toThrow(
        'single-scope guard trigger',
      );
    } finally {
      await getPool().query('ALTER TABLE budget_period_usage ENABLE TRIGGER budget_period_single_scope_trigger');
    }
    await expect(assertPostgresBudgetLedgerSchema()).resolves.toBeUndefined();
  });

  it('rejects when the identity unique index is dropped', async () => {
    await getPool().query('DROP INDEX IF EXISTS idx_budget_period_usage_identity_unique');
    try {
      await expect(assertPostgresBudgetLedgerSchema()).rejects.toThrow(
        'missing its identity unique index',
      );
    } finally {
      await getPool().query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_usage_identity_unique
          ON budget_period_usage (team_id, identity_id, window_kind, period_start)
          WHERE api_key_id IS NULL AND identity_id IS NOT NULL
      `);
    }
    await expect(assertPostgresBudgetLedgerSchema()).resolves.toBeUndefined();
  });

  it('rejects when the immutable trigger runs a stale 061 function body', async () => {
    // The 061 body (no identity_id freeze) with the same trigger name must fail.
    await getPool().query(`
      CREATE OR REPLACE FUNCTION budget_period_identity_immutable() RETURNS trigger AS $$
      BEGIN
        IF OLD.team_id IS DISTINCT FROM NEW.team_id
           OR OLD.api_key_id IS DISTINCT FROM NEW.api_key_id
           OR OLD.window_kind IS DISTINCT FROM NEW.window_kind
           OR OLD.period_start IS DISTINCT FROM NEW.period_start
           OR OLD.period_end IS DISTINCT FROM NEW.period_end THEN
          RAISE EXCEPTION 'budget_period_usage identity columns are immutable';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    try {
      await expect(assertPostgresBudgetLedgerSchema()).rejects.toThrow(
        'missing its identity/scope triggers',
      );
    } finally {
      await getPool().query(`
        CREATE OR REPLACE FUNCTION budget_period_identity_immutable() RETURNS trigger AS $$
        BEGIN
          IF OLD.team_id IS DISTINCT FROM NEW.team_id
             OR OLD.api_key_id IS DISTINCT FROM NEW.api_key_id
             OR OLD.identity_id IS DISTINCT FROM NEW.identity_id
             OR OLD.window_kind IS DISTINCT FROM NEW.window_kind
             OR OLD.period_start IS DISTINCT FROM NEW.period_start
             OR OLD.period_end IS DISTINCT FROM NEW.period_end THEN
            RAISE EXCEPTION 'budget_period_usage identity columns are immutable';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
    }
    await expect(assertPostgresBudgetLedgerSchema()).resolves.toBeUndefined();
  });

  it('rejects when the single-scope trigger has a never-firing WHEN filter', async () => {
    // A WHEN (false) qualifier keeps the trigger row present but inert —
    // the guard must not pass an inert scope control.
    await getPool().query(`
      DROP TRIGGER budget_period_single_scope_trigger ON budget_period_usage
    `);
    await getPool().query(`
      CREATE TRIGGER budget_period_single_scope_trigger
        BEFORE INSERT OR UPDATE ON budget_period_usage
        FOR EACH ROW WHEN (false) EXECUTE FUNCTION budget_period_single_scope()
    `);
    try {
      await expect(assertPostgresBudgetLedgerSchema()).rejects.toThrow(
        'single-scope guard trigger',
      );
    } finally {
      await getPool().query(`
        DROP TRIGGER budget_period_single_scope_trigger ON budget_period_usage
      `);
      await getPool().query(`
        CREATE TRIGGER budget_period_single_scope_trigger
          BEFORE INSERT OR UPDATE ON budget_period_usage
          FOR EACH ROW EXECUTE FUNCTION budget_period_single_scope()
      `);
    }
    await expect(assertPostgresBudgetLedgerSchema()).resolves.toBeUndefined();
  });

  it('rejects when identity_budget_caps is missing', async () => {
    await getPool().query('DROP TABLE IF EXISTS identity_budget_caps');
    try {
      await expect(assertPostgresBudgetLedgerSchema()).rejects.toThrow(
        'migration 065',
      );
    } finally {
      // Recreate per migration 065 (the seed rows are not needed for the guard).
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS identity_budget_caps (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          identity_id TEXT NOT NULL,
          daily_usd_cap numeric(20,8),
          weekly_usd_cap numeric(20,8),
          monthly_usd_cap numeric(20,8),
          cap_action TEXT NOT NULL DEFAULT 'alert' CHECK (cap_action IN ('alert', 'throttle', 'block')),
          soft_alert_at_pct numeric(5,2),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT identity_budget_caps_pkey PRIMARY KEY (team_id, identity_id),
          CONSTRAINT identity_budget_caps_identity_nonempty CHECK (length(identity_id) > 0),
          CONSTRAINT identity_budget_caps_daily_valid CHECK (daily_usd_cap IS NULL OR (daily_usd_cap >= 0 AND daily_usd_cap = trunc(daily_usd_cap, 8))),
          CONSTRAINT identity_budget_caps_weekly_valid CHECK (weekly_usd_cap IS NULL OR (weekly_usd_cap >= 0 AND weekly_usd_cap = trunc(weekly_usd_cap, 8))),
          CONSTRAINT identity_budget_caps_monthly_valid CHECK (monthly_usd_cap IS NULL OR (monthly_usd_cap >= 0 AND monthly_usd_cap = trunc(monthly_usd_cap, 8))),
          CONSTRAINT identity_budget_caps_alert_pct_valid CHECK (soft_alert_at_pct IS NULL OR (soft_alert_at_pct >= 0 AND soft_alert_at_pct <= 100))
        )
      `);
    }
    await expect(assertPostgresBudgetLedgerSchema()).resolves.toBeUndefined();
  });
});
