-- 011-request-logs-api-key.sql
-- Adds an api_key_id column to request_logs so per-key (and downstream
-- per-identity) usage rollups can JOIN request_logs ↔ api_keys. Nullable
-- because pre-this-migration rows have no key reference and we don't try
-- to backfill them.

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS api_key_id text;

CREATE INDEX IF NOT EXISTS idx_request_logs_api_key
  ON request_logs (api_key_id, timestamp DESC)
  WHERE api_key_id IS NOT NULL;
