-- 036-request-logs-plugin-warnings.sql
-- Persist exact plugin skip/failure reasons for plugin-assisted requests.

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS plugin_warnings JSONB NOT NULL DEFAULT '[]'::jsonb;
