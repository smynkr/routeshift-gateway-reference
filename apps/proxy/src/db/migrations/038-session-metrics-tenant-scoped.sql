-- 038-session-metrics-tenant-scoped.sql
-- Client-supplied session ids are not globally unique. Scope session rollups
-- and yield labels by (team_id, session_id) so two tenants using the same
-- x-routeshift-session-id cannot overwrite each other's observability rows.

ALTER TABLE session_yield
  DROP CONSTRAINT IF EXISTS session_yield_session_id_fkey;

ALTER TABLE session_yield
  DROP CONSTRAINT IF EXISTS session_yield_pkey;

ALTER TABLE session_metrics
  DROP CONSTRAINT IF EXISTS session_metrics_pkey;

ALTER TABLE session_metrics
  ADD CONSTRAINT session_metrics_pkey PRIMARY KEY (team_id, session_id);

ALTER TABLE session_yield
  ADD CONSTRAINT session_yield_pkey PRIMARY KEY (team_id, session_id);

ALTER TABLE session_yield
  ADD CONSTRAINT session_yield_session_metrics_fkey
  FOREIGN KEY (team_id, session_id)
  REFERENCES session_metrics (team_id, session_id)
  ON DELETE CASCADE;
