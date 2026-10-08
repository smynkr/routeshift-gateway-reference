CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'live',
  allowed_models TEXT[],
  rate_limit_override JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_team ON api_keys(team_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS routing_rules (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL DEFAULT '*',
  name TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 500,
  enabled BOOLEAN NOT NULL DEFAULT true,
  condition JSONB NOT NULL DEFAULT '{}',
  action JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_team ON routing_rules(team_id, priority) WHERE enabled = true;

INSERT INTO teams (id, name, plan) VALUES ('team_dev', 'Development', 'starter')
ON CONFLICT (id) DO NOTHING;
