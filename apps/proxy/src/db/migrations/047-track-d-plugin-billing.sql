-- Track D plugin billing and sanitized execution audit.
-- Provider cost stays in actual_cost_microcents; plugin fees are a separate
-- measured component added only at billing/reporting boundaries.

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS plugin_cost_microcents BIGINT NOT NULL DEFAULT 0;

-- Keep the existing session total as the routing/provider-only value used by
-- legacy efficiency consumers. Billed session spend is explicit so plugin
-- charges never get silently relabeled as routing cost.
ALTER TABLE session_metrics
  ADD COLUMN IF NOT EXISTS billed_cost_microcents BIGINT NOT NULL DEFAULT 0;

-- Sessions predate plugin billing, so their historical billed value is their
-- existing provider/routing total. The predicate keeps a manual rerun from
-- overwriting sessions that already have a non-zero plugin-inclusive total.
UPDATE session_metrics
   SET billed_cost_microcents = total_cost_microcents
 WHERE billed_cost_microcents = 0
   AND total_cost_microcents <> 0;

CREATE TABLE IF NOT EXISTS plugin_runs (
  id TEXT PRIMARY KEY,
  -- Logging is asynchronous and append-only, so do not make request-log
  -- persistence a foreign-key prerequisite for a durable plugin audit row.
  request_id TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'warning', 'error', 'skipped')),
  cost_microcents BIGINT NOT NULL DEFAULT 0 CHECK (cost_microcents >= 0),
  latency_ms INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  -- Stable outcome code only; never request content, URLs, filenames, or backend payloads.
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, plugin_id)
);

CREATE INDEX IF NOT EXISTS idx_plugin_runs_team_created
  ON plugin_runs (team_id, created_at DESC);
