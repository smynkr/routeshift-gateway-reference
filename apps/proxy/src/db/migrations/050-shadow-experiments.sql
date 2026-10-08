-- 050-shadow-experiments.sql
-- RSH-85 Phase 1: shadow experiment control plane + run telemetry stub.
-- team_id is TEXT (RouteShift tenant-id invariant — never uuid).

CREATE TABLE IF NOT EXISTS shadow_experiments (
  id            TEXT NOT NULL,
  team_id       TEXT NOT NULL,
  name          TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT false,

  -- Source selector
  source_provider TEXT NOT NULL,
  source_model    TEXT NOT NULL,

  -- Candidate
  candidate_provider TEXT NOT NULL,
  candidate_model    TEXT NOT NULL,

  -- Sampling
  sample_rate_ppm             INTEGER NOT NULL CHECK (sample_rate_ppm >= 0 AND sample_rate_ppm <= 1000000),
  sampling_version            TEXT NOT NULL,
  shadow_sampling_key_version TEXT NOT NULL,
  starts_at                   TIMESTAMPTZ,
  ends_at                     TIMESTAMPTZ,
  max_samples                 INTEGER NOT NULL DEFAULT 1000,

  -- Execution bounds
  deadline_ms       INTEGER NOT NULL DEFAULT 30000,
  max_concurrency   INTEGER NOT NULL DEFAULT 2,
  max_queue_count   INTEGER NOT NULL DEFAULT 100,
  max_queue_bytes   INTEGER NOT NULL DEFAULT 10485760,
  max_payload_bytes INTEGER NOT NULL DEFAULT 1048576,

  -- Funding (v1: platform_funded only)
  funding_mode             TEXT NOT NULL DEFAULT 'platform_funded' CHECK (funding_mode = 'platform_funded'),
  per_run_cap_microcents   BIGINT NOT NULL DEFAULT 50000000,
  aggregate_cap_microcents BIGINT NOT NULL DEFAULT 5000000000,

  -- RSH-72 verifier reference
  verifier_version TEXT NOT NULL,
  gate_fingerprint TEXT NOT NULL,

  -- Consent
  consent_provider_ack BOOLEAN NOT NULL DEFAULT false,
  consent_region_ack   BOOLEAN NOT NULL DEFAULT false,
  consent_privacy_ack  BOOLEAN NOT NULL DEFAULT false,
  approved_by          TEXT,
  approved_at          TIMESTAMPTZ,

  -- Lifecycle
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,
  disabled_reason TEXT,
  kill_switch_at  TIMESTAMPTZ,

  -- Composite PK: every query is team-scoped; the composite key lets
  -- shadow_runs FK reference (team_id, experiment_id) directly.
  PRIMARY KEY (team_id, id)
);

CREATE INDEX IF NOT EXISTS idx_shadow_experiments_team_enabled
  ON shadow_experiments (team_id, enabled);

-- ─── shadow_runs (Phase 2 telemetry stub — schema only, no API yet) ─────────

CREATE TABLE IF NOT EXISTS shadow_runs (
  id                TEXT NOT NULL,
  experiment_id     TEXT NOT NULL,
  team_id           TEXT NOT NULL,
  parent_request_id TEXT NOT NULL,
  api_key_id        TEXT,

  -- Sampling audit
  sampling_version TEXT NOT NULL,
  sample_bucket    INTEGER NOT NULL,
  sample_rate_ppm  INTEGER NOT NULL,

  -- Lifecycle timestamps
  queued_at    TIMESTAMPTZ,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  dropped_at   TIMESTAMPTZ,

  -- Status
  status TEXT NOT NULL DEFAULT 'queued',
  reason TEXT NOT NULL,

  -- Primary (served) context
  primary_provider TEXT,
  primary_model    TEXT,

  -- Candidate execution
  candidate_provider               TEXT,
  candidate_model                  TEXT,
  candidate_latency_ms             INTEGER,
  candidate_input_tokens           INTEGER,
  candidate_output_tokens          INTEGER,
  candidate_cache_read_tokens      INTEGER,
  candidate_actual_cost_microcents BIGINT,
  candidate_estimated_cost_microcents BIGINT,
  cost_quality TEXT,

  -- Funding
  funding_mode TEXT NOT NULL DEFAULT 'platform_funded',
  key_source   TEXT,

  -- Correlation (no raw content)
  candidate_provider_request_id TEXT,
  canonical_message_hmac        TEXT,
  hmac_namespace_version        TEXT,

  -- RSH-72 verifier output
  verifier_version        TEXT,
  gate_fingerprint        TEXT,
  primary_verdict         TEXT,
  primary_reason          TEXT,
  primary_check_index     INTEGER,
  candidate_verdict       TEXT,
  candidate_reason        TEXT,
  candidate_check_index   INTEGER,

  -- Error / trace
  error_code    TEXT,
  trace_span_id TEXT,

  PRIMARY KEY (team_id, id),

  CONSTRAINT fk_shadow_runs_experiment
    FOREIGN KEY (team_id, experiment_id)
    REFERENCES shadow_experiments (team_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shadow_runs_experiment
  ON shadow_runs (team_id, experiment_id);
CREATE INDEX IF NOT EXISTS idx_shadow_runs_parent
  ON shadow_runs (team_id, parent_request_id);
