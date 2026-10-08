-- 015-request-logs-activity-category.sql
-- Adds an activity_category column for CodeBurn-style observability (LAY-310).
-- Only forward-looking traffic gets categorized; older rows stay NULL and
-- render as "uncategorized" in the dashboard.

ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS activity_category text;

CREATE INDEX IF NOT EXISTS idx_request_logs_team_time_category
  ON request_logs (team_id, timestamp DESC, activity_category);
