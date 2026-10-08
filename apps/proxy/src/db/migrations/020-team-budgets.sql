-- 020-team-budgets.sql
-- LAY-317: per-team monthly spend cap with optional enforcement.
--
-- monthly_usd_cap NULL => budget tracking disabled (default opt-in).
-- alert_at_pct: dashboard banner threshold (e.g. 80 = warn at 80% of cap).
-- hard_cap_action:
--   'alert'    — log breach, never affect traffic
--   'throttle' — 429 + Retry-After once cap is exceeded
--   'block'    — 402 Payment Required once cap is exceeded
--
-- Auto-resets at calendar-month boundaries naturally — `month_to_date`
-- spend computed live from request_logs, not stored.

CREATE TABLE IF NOT EXISTS team_budgets (
  team_id uuid PRIMARY KEY,
  monthly_usd_cap numeric,
  alert_at_pct integer NOT NULL DEFAULT 80
    CHECK (alert_at_pct >= 0 AND alert_at_pct <= 100),
  hard_cap_action text NOT NULL DEFAULT 'alert'
    CHECK (hard_cap_action IN ('alert', 'throttle', 'block')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
