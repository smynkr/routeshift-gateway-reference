ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS traceparent varchar(255);
