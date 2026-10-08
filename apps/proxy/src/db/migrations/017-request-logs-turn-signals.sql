-- 017-request-logs-turn-signals.sql
-- Adds the per-turn signals the LAY-314 session aggregation needs to detect
-- retry cycles (Edit → Bash → Edit on same file within ≤3 turns).
--   * edited_paths: paths touched by Edit/Write/NotebookEdit this turn
--   * had_bash:     whether any Bash command ran this turn
-- We store the projection rather than the full tool_call payload so the
-- aggregation can scan it without re-parsing JSON.

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS edited_paths text[];
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS had_bash boolean;
