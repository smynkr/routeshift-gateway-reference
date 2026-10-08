-- 062-quality-derank.sql
-- RSH-136: rolling quality derank from RSH-72 cascade verdicts.
--
-- Two additive pieces:
-- 1. quality_verdicts — one sanitized row per cascade attempt outcome
--    (provider, model, outcome, exact reason code). No prompt/response/
--    schema/credential; the rows come from the existing sanitized
--    AttemptAudit records that were previously counted and then dropped.
--    Terminal outcomes (refusal/safety/engine error) are recorded for
--    provenance but are policy outcomes, NOT quality signals: the
--    aggregation query counts only verified + quality_rejected.
-- 2. team_auto_route_settings.quality_derank — OPT-IN derank switch
--    (default false). RSH-136 forbids an on-by-default posture; the column
--    existing with a DEFAULT false is the off state.

CREATE TABLE IF NOT EXISTS quality_verdicts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_code TEXT,
  check_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quality_verdicts_id_nonempty CHECK (length(id) > 0),
  CONSTRAINT quality_verdicts_outcome_valid CHECK (outcome IN ('verified', 'quality_rejected', 'retryable_http', 'transport_error', 'terminal')),
  -- NOTE: this CHECK mirrors the AttemptOutcome union in
  -- apps/proxy/src/routing/quality-cascade.ts — adding a new outcome kind
  -- there REQUIRES extending this CHECK, or every batch containing the new
  -- kind fails atomically (writer swallows + logs). Pinned by the
  -- quality-derank-admin persistence test.
  CONSTRAINT quality_verdicts_attempt_nonnegative CHECK (attempt_index >= 0)
);

-- The derank aggregation scans the rolling window (`created_at >= $1`,
-- GROUP BY provider, model) — the created_at index serves that range scan.
-- The provider/model composite supports per-model lookups once narrower
-- WHERE clauses (provider = ...) are added. (The unique
-- (request_id, attempt_index) index below already covers request_id
-- lookups, so no separate request index is needed.)
CREATE INDEX IF NOT EXISTS idx_quality_verdicts_created
  ON quality_verdicts (created_at);
CREATE INDEX IF NOT EXISTS idx_quality_verdicts_provider_model_created
  ON quality_verdicts (provider, model, created_at);

-- Idempotency: a (request_id, attempt_index) pair may exist once — a retried
-- or duplicated persist inserts nothing twice (the writer uses
-- ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_verdicts_request_attempt
  ON quality_verdicts (request_id, attempt_index);

ALTER TABLE team_auto_route_settings
  ADD COLUMN IF NOT EXISTS quality_derank BOOLEAN NOT NULL DEFAULT false;
