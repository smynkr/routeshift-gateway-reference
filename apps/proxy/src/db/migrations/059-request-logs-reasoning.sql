-- RSH-159: preserve optional provider reasoning telemetry for analytics.
-- Nullable keeps pre-feature rows distinguishable from measured zero values.
ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS reasoning_tokens integer,
  ADD COLUMN IF NOT EXISTS reasoning_cost_microcents bigint;
