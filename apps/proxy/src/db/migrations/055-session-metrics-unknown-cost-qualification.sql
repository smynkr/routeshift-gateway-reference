-- Keep session-derived billed-spend metrics explicitly qualified. Request logs
-- remain immutable observations; this is a replayable projection backfill.
ALTER TABLE session_metrics
  ADD COLUMN IF NOT EXISTS unknown_cost_requests INTEGER NOT NULL DEFAULT 0;

-- Existing closed sessions predate the projection column. Recompute the count
-- at the same (team_id, session_id) grain used by session_metrics.
UPDATE session_metrics AS metrics
   SET unknown_cost_requests = source.unknown_cost_requests
  FROM (
    SELECT team_id,
           session_id,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::integer AS unknown_cost_requests
      FROM request_logs
     WHERE session_id IS NOT NULL
     GROUP BY team_id, session_id
  ) AS source
 WHERE metrics.team_id = source.team_id
   AND metrics.session_id = source.session_id;
