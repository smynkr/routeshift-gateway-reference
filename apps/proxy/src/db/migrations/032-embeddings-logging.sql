ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS request_kind TEXT NOT NULL DEFAULT 'chat'
  CHECK (request_kind IN ('chat', 'embedding'));

CREATE INDEX IF NOT EXISTS idx_request_logs_team_kind
  ON request_logs (team_id, request_kind, timestamp DESC);
