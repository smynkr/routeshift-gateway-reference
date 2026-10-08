-- 016-request-logs-session-id.sql
-- Adds session_id to request_logs for one-shot / retry-rate analysis (LAY-314).
-- Sessions are derived at log-write time: explicit `x-routeshift-session-id`
-- or `x-conversation-id` headers win, otherwise sha256(team|key|first_msg|
-- 30-min bucket) so the same conversation gets a stable id without server
-- state. Older rows stay NULL and are ignored by session aggregations.

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS session_id text;

CREATE INDEX IF NOT EXISTS idx_request_logs_team_session_time
  ON request_logs (team_id, session_id, timestamp)
  WHERE session_id IS NOT NULL;
