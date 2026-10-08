-- 025-api-key-audit-events.sql
-- LAY-331: per-key lifecycle events. RouteShift today only tracks
-- api_keys.last_used; this table answers "who revoked the prod key?",
-- "how many auth failures did the leaked key get before revoke?", etc.
--
-- api_key_id is nullable so we can record auth_failed for prefixes that
-- don't match any key (the failing prefix is captured separately for
-- correlation). Source IPs / user-agent live in details jsonb to avoid
-- a forced schema bump every time we add a context dimension.

CREATE TABLE IF NOT EXISTS api_key_audit_events (
  id uuid PRIMARY KEY,
  team_id text NOT NULL,
  api_key_id uuid,
  key_prefix text,
  event_type text NOT NULL,
  actor_user_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_key_audit_events_event_type_values
    CHECK (event_type IN ('created', 'revoked', 'auth_failed', 'rate_limited', 'budget_exceeded'))
);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_events_team_time
  ON api_key_audit_events (team_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_audit_events_key_time
  ON api_key_audit_events (api_key_id, created_at DESC)
  WHERE api_key_id IS NOT NULL;
