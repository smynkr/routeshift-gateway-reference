-- 018-session-metrics.sql
-- Session-level rollup of one-shot / retry-rate metrics for LAY-314 phase 3.
-- Refreshed by a 5-min cron (apps/proxy/src/observability/session-aggregator.ts)
-- over closed sessions only (last activity ≥30 min ago) so a chatty live
-- session doesn't churn rows. one_shot_rate is NULL when the session had no
-- edit turns — render as "—" in the UI rather than 0% so empty sessions
-- don't drag the average.

CREATE TABLE IF NOT EXISTS session_metrics (
  session_id text PRIMARY KEY,
  team_id text NOT NULL,
  edit_turns int NOT NULL DEFAULT 0,
  retry_turns int NOT NULL DEFAULT 0,
  one_shot_rate numeric(5, 4),
  primary_model text,
  total_cost_microcents bigint NOT NULL DEFAULT 0,
  first_request_at timestamptz NOT NULL,
  last_request_at timestamptz NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_metrics_team_time
  ON session_metrics (team_id, last_request_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_metrics_team_model
  ON session_metrics (team_id, primary_model)
  WHERE primary_model IS NOT NULL;
