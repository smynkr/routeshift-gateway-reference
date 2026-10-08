-- 028-session-yield.sql
-- LAY-311: nightly correlation between RouteShift sessions and Layer-tracked
-- git commits. Populated by yield-correlator.ts; read by the dashboard /yield
-- page. teams.layer_tenant_id is the routing key into Layer's git_commits
-- ledger (one Layer tenant ↔ one RouteShift team in v1; revisit if a single
-- team ever spans multiple Layer tenants).

ALTER TABLE teams ADD COLUMN IF NOT EXISTS layer_tenant_id uuid;

-- RSH-55 note: this FK references session_metrics(session_id), which was the
-- single-column PK when this migration was written (018). Migration 038
-- (session-metrics-tenant-scoped) makes session_metrics' PK composite
-- (team_id, session_id) and DROPs/RECREATEs both this PK and FK as composite.
-- Fresh deploys are valid because migrations run in order (028 valid, then 038
-- supersedes). Do NOT add new FKs to session_metrics(session_id) alone — it is
-- no longer unique after 038; reference (team_id, session_id).
CREATE TABLE IF NOT EXISTS session_yield (
  session_id          text PRIMARY KEY REFERENCES session_metrics(session_id) ON DELETE CASCADE,
  team_id             text NOT NULL,
  label               text NOT NULL CHECK (label IN ('productive', 'reverted', 'abandoned')),
  matched_commit_sha  text,
  matched_commit_repo text,
  matched_commit_at   timestamptz,
  reverted_at         timestamptz,
  session_ended_at    timestamptz NOT NULL,
  computed_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_yield_team_time
  ON session_yield (team_id, session_ended_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_yield_team_label
  ON session_yield (team_id, label, session_ended_at DESC);
