-- RSH-139: per-team guardrail configuration for pre-dispatch scanning.
-- Default OFF: teams must explicitly enable scanning.

CREATE TABLE IF NOT EXISTS team_guardrail_configs (
  team_id TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE team_guardrail_configs IS 'Per-team guardrail scanning configuration. Default off; teams opt in explicitly.';
COMMENT ON COLUMN team_guardrail_configs.config IS 'JSON: { patterns: [{ id, enabled, customRegex?, action? }] }';
