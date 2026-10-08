-- 025-request-logs-system-prompt-and-message-hash.sql
-- LAY-328: per-request signals the Optimize engine needs to detect
-- oversized system prompts and duplicate requests.
--
-- system_prompt_tokens — token count of the canonical request's
--   `system_prompt` field, populated at log time using the same chars/4
--   heuristic the cost calculator uses. NULL for legacy rows.
--
-- message_hash — SHA-256 of JSON.stringify({messages, system, tools})
--   truncated to the first 16 chars. We control input shape so the 64-bit
--   space is plenty. Used to detect duplicate requests for the
--   response-cache rule. NULL for legacy rows.

ALTER TABLE request_logs
  ADD COLUMN IF NOT EXISTS system_prompt_tokens int,
  ADD COLUMN IF NOT EXISTS message_hash text;

-- Partial composite index — only rows with a hash, ordered by recency so
-- the duplicate-requests rule's GROUP BY message_hash within the lookback
-- window is a cheap index range scan instead of a seq scan.
CREATE INDEX IF NOT EXISTS idx_request_logs_team_message_hash
  ON request_logs (team_id, message_hash, timestamp DESC)
  WHERE message_hash IS NOT NULL;
