-- 023-request-logs-rate-limited.sql
-- LAY-320: per-credential rate-limit cooldowns. Stamps each row that either
-- (a) received a 429 from upstream, or (b) was selected because at least one
-- other credential in the bucket was on cooldown. Used by the dashboard to
-- spot when traffic is being reshaped around 429s.

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS rate_limited boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_request_logs_rate_limited
  ON request_logs (team_id, timestamp DESC)
  WHERE rate_limited = true;
