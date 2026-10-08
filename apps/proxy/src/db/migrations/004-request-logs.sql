CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  team_id TEXT NOT NULL DEFAULT 'team_dev',
  provider TEXT NOT NULL,
  model_requested TEXT NOT NULL,
  model_resolved TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  original_cost_microcents BIGINT NOT NULL DEFAULT 0,
  actual_cost_microcents BIGINT NOT NULL DEFAULT 0,
  savings_microcents BIGINT NOT NULL DEFAULT 0,
  total_latency_ms INTEGER NOT NULL,
  ttft_ms INTEGER,
  is_streaming BOOLEAN NOT NULL DEFAULT false,
  is_fallback BOOLEAN NOT NULL DEFAULT false,
  fallback_attempts JSONB NOT NULL DEFAULT '[]'::jsonb,
  plugin_warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  status_code SMALLINT NOT NULL DEFAULT 200,
  error_type TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_logs_team_time ON request_logs(team_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(team_id, model_resolved, timestamp DESC);
