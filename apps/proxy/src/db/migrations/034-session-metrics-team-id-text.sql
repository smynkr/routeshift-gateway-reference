-- 034-session-metrics-team-id-text.sql
-- Keep session_metrics.team_id aligned with teams.id and request_logs.team_id.
-- Self-serve registration creates team_<hex> ids, so uuid rejected valid teams.
-- Existing UUID rows are preserved by casting to text; future team_* rows need
-- no separate backfill because the table stores the same literal team id.

ALTER TABLE session_metrics
  ALTER COLUMN team_id TYPE text USING team_id::text;
