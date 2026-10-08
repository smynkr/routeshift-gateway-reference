-- 065-identity-budget-caps.sql
-- RSH-140: per-identity budget caps — a per-person ceiling across all of a
-- person's keys, enforced by the same RSH-138 reservation ledger as the
-- team and key scopes. The identity is `metadata.layer_identity_id` on the
-- calling key (AXI-8 attribution of record), derived at request time; a key
-- without it simply has no identity scope.
--
-- Additive:
-- 1. identity_budget_caps — the caps table (same cap-shape + quantization
--    CHECK as team_budgets; tenant ids stay TEXT).
-- 2. budget_period_usage.identity_id + budget_reservations.identity_id —
--    the ledger's third scope dimension. Identity period rows are
--    api_key_id NULL + identity_id NOT NULL, with their own partial unique
--    index, immutability guard, and scope-match trigger (mirroring the
--    061 patterns for team/key rows).

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
);

ALTER TABLE budget_period_usage
  ADD COLUMN IF NOT EXISTS identity_id TEXT;
ALTER TABLE budget_reservations
  ADD COLUMN IF NOT EXISTS identity_id TEXT;

-- The 061 team unique index (WHERE api_key_id IS NULL) must be NARROWED:
-- identity rows are also api_key_id NULL, so without the identity predicate
-- they would collide with the team row on (team, window, period_start).
DROP INDEX IF EXISTS idx_budget_period_usage_team_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_usage_team_unique
  ON budget_period_usage (team_id, window_kind, period_start)
  WHERE api_key_id IS NULL AND identity_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_usage_identity_unique
  ON budget_period_usage (team_id, identity_id, window_kind, period_start)
  WHERE api_key_id IS NULL AND identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_budget_period_usage_identity_lookup
  ON budget_period_usage (team_id, identity_id, window_kind, period_end)
  WHERE api_key_id IS NULL AND identity_id IS NOT NULL;

-- Immutability: identity + scope identity never change after creation.
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
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS budget_period_identity_immutable_trigger ON budget_period_usage;
CREATE TRIGGER budget_period_identity_immutable_trigger
  BEFORE UPDATE ON budget_period_usage
  FOR EACH ROW EXECUTE FUNCTION budget_period_identity_immutable();

-- A period row may carry at most ONE scope dimension beyond team.
CREATE OR REPLACE FUNCTION budget_period_single_scope() RETURNS trigger AS $$
BEGIN
  IF (NEW.api_key_id IS NOT NULL AND NEW.identity_id IS NOT NULL) THEN
    RAISE EXCEPTION 'budget_period_usage cannot carry both api_key_id and identity_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS budget_period_single_scope_trigger ON budget_period_usage;
CREATE TRIGGER budget_period_single_scope_trigger
  BEFORE INSERT OR UPDATE ON budget_period_usage
  FOR EACH ROW EXECUTE FUNCTION budget_period_single_scope();

-- A reservation row's scope must exactly mirror its referenced period row.
CREATE OR REPLACE FUNCTION budget_reservation_scope_matches_period() RETURNS trigger AS $$
DECLARE
  period_team TEXT;
  period_key TEXT;
  period_identity TEXT;
BEGIN
  SELECT team_id, api_key_id, identity_id INTO period_team, period_key, period_identity
    FROM budget_period_usage WHERE id = NEW.period_id;
  IF period_team IS NULL THEN
    RAISE EXCEPTION 'budget_reservations references unknown period %', NEW.period_id;
  END IF;
  IF NEW.team_id IS DISTINCT FROM period_team
     OR NEW.api_key_id IS DISTINCT FROM period_key
     OR NEW.identity_id IS DISTINCT FROM period_identity THEN
    RAISE EXCEPTION 'budget_reservations scope does not match its period %', NEW.period_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS budget_reservation_scope_matches_period_trigger ON budget_reservations;
CREATE TRIGGER budget_reservation_scope_matches_period_trigger
  BEFORE INSERT OR UPDATE ON budget_reservations
  FOR EACH ROW EXECUTE FUNCTION budget_reservation_scope_matches_period();
