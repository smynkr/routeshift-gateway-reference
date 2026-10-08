-- 035-request-logs-fallback-attempts.sql
-- Persist exact provider/model/error details for fallback chains.

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS fallback_attempts JSONB NOT NULL DEFAULT '[]'::jsonb;
