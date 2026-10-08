-- Preserve whether request_logs.actual_cost_microcents is exact. A numeric
-- lower bound must never be mistaken for a zero-cost upstream attempt.
ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS actual_cost_known boolean NOT NULL DEFAULT true;
