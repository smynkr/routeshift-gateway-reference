-- 061-budget-reset-windows.sql
-- RSH-138: daily/weekly budget reset windows beside the existing monthly
-- window. Additive only: existing config columns remain untouched and no
-- existing table is rewritten.
--
-- The budget ledger is replica-safe: one durable desk row per scope/window
-- period, one reservation row per request and period, and an insert-once
-- historical seed ledger row per (period, request). Tenant ids stay TEXT.
-- Money columns are BIGINT integer microcents (1 USD = 100_000_000
-- microcents); caps are numeric(20,8) with an explicit <= 8 fractional
-- decimal quantization CHECK (the application-level exact decimal parser is
-- the authoritative guard; the CHECK keeps out-of-band writes honest).
-- Every instant column is TIMESTAMPTZ so transaction_timestamp() /
-- clock_timestamp() comparisons are session-TimeZone independent.

ALTER TABLE team_budgets
  ADD COLUMN IF NOT EXISTS daily_usd_cap numeric(20,8),
  ADD COLUMN IF NOT EXISTS weekly_usd_cap numeric(20,8);

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS daily_usd_cap numeric(20,8),
  ADD COLUMN IF NOT EXISTS weekly_usd_cap numeric(20,8);

ALTER TABLE team_budgets DROP CONSTRAINT IF EXISTS team_budgets_daily_usd_cap_valid;
ALTER TABLE team_budgets ADD CONSTRAINT team_budgets_daily_usd_cap_valid
  CHECK (daily_usd_cap IS NULL OR (daily_usd_cap >= 0 AND daily_usd_cap = trunc(daily_usd_cap, 8)));
ALTER TABLE team_budgets DROP CONSTRAINT IF EXISTS team_budgets_weekly_usd_cap_valid;
ALTER TABLE team_budgets ADD CONSTRAINT team_budgets_weekly_usd_cap_valid
  CHECK (weekly_usd_cap IS NULL OR (weekly_usd_cap >= 0 AND weekly_usd_cap = trunc(weekly_usd_cap, 8)));

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_daily_usd_cap_valid;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_daily_usd_cap_valid
  CHECK (daily_usd_cap IS NULL OR (daily_usd_cap >= 0 AND daily_usd_cap = trunc(daily_usd_cap, 8)));
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_weekly_usd_cap_valid;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_weekly_usd_cap_valid
  CHECK (weekly_usd_cap IS NULL OR (weekly_usd_cap >= 0 AND weekly_usd_cap = trunc(weekly_usd_cap, 8)));
-- Legacy monthly columns predate the exact-quantization contract; bring them
-- under the same non-negative / 8-decimal rule as the daily and weekly caps.
-- NOT VALID: existing rows were never constrained, and a validating ADD
-- CONSTRAINT would full-scan (and abort the deploy on) any legacy negative or
-- >8-decimal value. New writes are enforced; legacy rows surface via reports.
ALTER TABLE team_budgets DROP CONSTRAINT IF EXISTS team_budgets_monthly_usd_cap_valid;
ALTER TABLE team_budgets ADD CONSTRAINT team_budgets_monthly_usd_cap_valid
  CHECK (monthly_usd_cap IS NULL OR (monthly_usd_cap >= 0 AND monthly_usd_cap = trunc(monthly_usd_cap, 8))) NOT VALID;
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_monthly_usd_cap_valid;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_monthly_usd_cap_valid
  CHECK (monthly_usd_cap IS NULL OR (monthly_usd_cap >= 0 AND monthly_usd_cap = trunc(monthly_usd_cap, 8))) NOT VALID;

CREATE TABLE IF NOT EXISTS budget_period_usage (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id) NOT NULL,
  api_key_id TEXT REFERENCES api_keys(id) ON DELETE NO ACTION,
  window_kind TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  reserved_microcents BIGINT NOT NULL DEFAULT 0,
  unknown_held_microcents BIGINT NOT NULL DEFAULT 0,
  actual_microcents BIGINT NOT NULL DEFAULT 0,
  unknown_cost_requests BIGINT NOT NULL DEFAULT 0,
  seeded_at TIMESTAMPTZ,
  seeded_through TIMESTAMPTZ,
  seeded_request_count BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_period_usage_id_nonempty CHECK (length(id) > 0),
  CONSTRAINT budget_period_usage_window_valid CHECK (window_kind IN ('daily', 'weekly', 'monthly')),
  CONSTRAINT budget_period_usage_reserved_nonnegative CHECK (reserved_microcents >= 0),
  CONSTRAINT budget_period_usage_unknown_held_nonnegative CHECK (unknown_held_microcents >= 0),
  CONSTRAINT budget_period_usage_actual_nonnegative CHECK (actual_microcents >= 0),
  CONSTRAINT budget_period_usage_unknown_count_nonnegative CHECK (unknown_cost_requests >= 0),
  CONSTRAINT budget_period_usage_period_order CHECK (period_start < period_end)
);

-- The unique index pair must stay exact: team rows and key rows are
-- separate partial indexes so team/key identity can never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_usage_team_unique
  ON budget_period_usage (team_id, window_kind, period_start)
  WHERE api_key_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_usage_key_unique
  ON budget_period_usage (team_id, api_key_id, window_kind, period_start)
  WHERE api_key_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budget_period_usage_active_lookup
  ON budget_period_usage (team_id, window_kind, period_end);
CREATE INDEX IF NOT EXISTS idx_budget_period_usage_key_lookup
  ON budget_period_usage (api_key_id, window_kind, period_end)
  WHERE api_key_id IS NOT NULL;

-- Immutability of period identity: scope, window, and bounds never change.
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS budget_period_identity_immutable_trigger ON budget_period_usage;
CREATE TRIGGER budget_period_identity_immutable_trigger
  BEFORE UPDATE ON budget_period_usage
  FOR EACH ROW EXECUTE FUNCTION budget_period_identity_immutable();

-- A key-scope period row may only reference a key owned by its team.
CREATE OR REPLACE FUNCTION budget_period_key_belongs_to_team() RETURNS trigger AS $$
DECLARE
  key_team TEXT;
BEGIN
  IF NEW.api_key_id IS NOT NULL THEN
    SELECT team_id INTO key_team FROM api_keys WHERE id = NEW.api_key_id;
    IF key_team IS NULL THEN
      RAISE EXCEPTION 'budget_period_usage references unknown api_key %', NEW.api_key_id;
    END IF;
    IF key_team IS DISTINCT FROM NEW.team_id THEN
      RAISE EXCEPTION 'budget_period_usage api_key % belongs to a different team', NEW.api_key_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS budget_period_key_belongs_to_team_trigger ON budget_period_usage;
CREATE TRIGGER budget_period_key_belongs_to_team_trigger
  BEFORE INSERT OR UPDATE ON budget_period_usage
  FOR EACH ROW EXECUTE FUNCTION budget_period_key_belongs_to_team();

CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  period_id TEXT REFERENCES budget_period_usage(id) NOT NULL,
  request_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  api_key_id TEXT,
  estimated_microcents BIGINT NOT NULL,
  actual_microcents BIGINT NOT NULL DEFAULT 0,
  unknown_held_microcents BIGINT NOT NULL DEFAULT 0,
  known_lower_bound_microcents BIGINT,
  estimate_unavailable BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_expires_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  CONSTRAINT budget_reservations_status_valid CHECK (status IN ('pending', 'settled', 'released', 'unknown_held')),
  CONSTRAINT budget_reservations_estimated_nonnegative CHECK (estimated_microcents >= 0),
  CONSTRAINT budget_reservations_actual_nonnegative CHECK (actual_microcents >= 0),
  CONSTRAINT budget_reservations_unknown_held_nonnegative CHECK (unknown_held_microcents >= 0),
  CONSTRAINT budget_reservations_lower_bound_nonnegative CHECK (known_lower_bound_microcents IS NULL OR known_lower_bound_microcents >= 0),
  -- Per-row bound: held can never exceed this request's own estimate.
  CONSTRAINT budget_reservations_unknown_held_within_estimate CHECK (unknown_held_microcents <= estimated_microcents)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_reservations_period_request
  ON budget_reservations (period_id, request_id);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_request_period
  ON budget_reservations (request_id, period_id);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_pending_lease
  ON budget_reservations (period_id, lease_expires_at)
  WHERE status = 'pending';

-- A reservation row's scope must exactly mirror its referenced period row.
CREATE OR REPLACE FUNCTION budget_reservation_scope_matches_period() RETURNS trigger AS $$
DECLARE
  period_team TEXT;
  period_key TEXT;
BEGIN
  SELECT team_id, api_key_id INTO period_team, period_key
    FROM budget_period_usage WHERE id = NEW.period_id;
  IF period_team IS NULL THEN
    RAISE EXCEPTION 'budget_reservations references unknown period %', NEW.period_id;
  END IF;
  IF NEW.team_id IS DISTINCT FROM period_team
     OR NEW.api_key_id IS DISTINCT FROM period_key THEN
    RAISE EXCEPTION 'budget_reservations scope does not match its period %', NEW.period_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS budget_reservation_scope_matches_period_trigger ON budget_reservations;
CREATE TRIGGER budget_reservation_scope_matches_period_trigger
  BEFORE INSERT OR UPDATE ON budget_reservations
  FOR EACH ROW EXECUTE FUNCTION budget_reservation_scope_matches_period();

CREATE TABLE IF NOT EXISTS budget_period_seeded_requests (
  period_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  actual_microcents BIGINT NOT NULL DEFAULT 0,
  known_cost BOOLEAN NOT NULL,
  seeded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budget_period_seeded_requests_pkey PRIMARY KEY (period_id, request_id),
  CONSTRAINT budget_period_seeded_requests_period_fk FOREIGN KEY (period_id) REFERENCES budget_period_usage(id),
  CONSTRAINT budget_period_seeded_requests_actual_nonnegative CHECK (actual_microcents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_budget_period_seeded_requests_request
  ON budget_period_seeded_requests (request_id, period_id);
