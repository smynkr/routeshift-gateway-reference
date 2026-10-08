-- RSH-135: per-team classifier configuration and classification results.
-- Default OFF: teams must explicitly enable classification.

CREATE TABLE IF NOT EXISTS team_classifier_configs (
  team_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  sample_rate_bps INTEGER NOT NULL DEFAULT 1000,
  classifier_provider TEXT NOT NULL DEFAULT 'openai',
  classifier_model TEXT NOT NULL DEFAULT 'gpt-4.1-nano',
  dimensions JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE team_classifier_configs IS 'Per-team LLM classifier configuration for spend attribution. Default off; teams opt in explicitly.';
COMMENT ON COLUMN team_classifier_configs.sample_rate_bps IS 'Sampling rate in basis points (100 = 1%, 10000 = 100%). Clamped to 100-10000.';
COMMENT ON COLUMN team_classifier_configs.dimensions IS 'JSON array of {id, name, prompt, values[]} — max 8 dimensions.';

CREATE TABLE IF NOT EXISTS classification_results (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  dimensions JSONB NOT NULL,
  cost_microcents BIGINT NOT NULL,
  latency_ms INTEGER,
  classified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classification_results_team_time
  ON classification_results (team_id, classified_at DESC);

COMMENT ON TABLE classification_results IS 'Async classification results. Stores only dimension tags — never prompt or completion text.';
