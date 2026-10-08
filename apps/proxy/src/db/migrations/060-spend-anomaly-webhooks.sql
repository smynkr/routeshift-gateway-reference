-- RSH-161: team-scoped signed spend anomaly alert configuration and delivery state.
-- The signing secret is process configuration, never persisted here.
CREATE TABLE IF NOT EXISTS spend_alert_configs (
  team_id               TEXT        PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  enabled               BOOLEAN     NOT NULL DEFAULT false,
  webhook_url           TEXT        NOT NULL DEFAULT ''
    CHECK (webhook_url = '' OR webhook_url ~ '^https://[^[:space:]]+$'),
  threshold_multiplier  NUMERIC     NOT NULL DEFAULT 2
    CHECK (threshold_multiplier >= 1 AND threshold_multiplier <= 100),
  baseline_days         INTEGER     NOT NULL DEFAULT 7
    CHECK (baseline_days >= 1 AND baseline_days <= 90),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spend_alert_configs_enabled
  ON spend_alert_configs (enabled)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS spend_alert_deliveries (
  team_id       TEXT        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  metric        TEXT        NOT NULL,
  period_end    DATE        NOT NULL,
  event_id      TEXT        NOT NULL,
  body          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempt_count INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  response_code INTEGER,
  error_text    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, metric, period_end)
);

CREATE INDEX IF NOT EXISTS idx_spend_alert_deliveries_pending
  ON spend_alert_deliveries (status, updated_at)
  WHERE status IN ('pending', 'failed');
