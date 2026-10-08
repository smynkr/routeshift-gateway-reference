ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cache_hit BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_request_logs_cache_hit ON request_logs(team_id, timestamp DESC) WHERE cache_hit = true;
CREATE INDEX IF NOT EXISTS idx_request_logs_provider ON request_logs(team_id, provider, timestamp DESC);
