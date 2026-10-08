-- 024-api-keys-budgets.sql
-- LAY-329: per-key monthly budget. Mirrors team_budgets (LAY-317) at the key
-- level so an admin can cap a customer's pilot key at $50/mo without
-- changing the team-wide policy.
--
-- monthly_usd_cap NULL = no cap. cap_action='alert' is soft (banner only);
-- 'throttle' returns 429 with Retry-After to next month; 'block' returns 402.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS monthly_usd_cap numeric,
  ADD COLUMN IF NOT EXISTS soft_alert_at_pct integer NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS cap_action text NOT NULL DEFAULT 'alert';

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_soft_alert_at_pct_range
    CHECK (soft_alert_at_pct BETWEEN 0 AND 100);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_cap_action_values
    CHECK (cap_action IN ('alert', 'throttle', 'block'));

CREATE INDEX IF NOT EXISTS idx_api_keys_with_budget
  ON api_keys (team_id)
  WHERE monthly_usd_cap IS NOT NULL;
