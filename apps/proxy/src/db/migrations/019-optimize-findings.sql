-- 019-optimize-findings.sql
-- LAY-315: ranked, copy-paste-fixable waste findings produced nightly by
-- the optimize engine (apps/proxy/src/optimize/). Findings are deduped by
-- (team_id, rule_id) — re-running the rule updates last_seen_at and the
-- savings estimate without producing a new row. Status auto-flips to
-- 'resolved' when a rule no longer detects the pattern for 48h, so the UI
-- doesn't accumulate stale advice.

CREATE TABLE IF NOT EXISTS optimize_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL,
  rule_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  estimated_savings_microcents bigint NOT NULL DEFAULT 0,
  body_md text NOT NULL,
  fix_md text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (team_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_optimize_findings_team_status
  ON optimize_findings (team_id, status, severity);

CREATE INDEX IF NOT EXISTS idx_optimize_findings_team_last_seen
  ON optimize_findings (team_id, last_seen_at DESC);
