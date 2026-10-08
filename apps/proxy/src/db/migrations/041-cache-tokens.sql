ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cache_read_tokens integer DEFAULT 0 NOT NULL;
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cache_write_tokens integer DEFAULT 0 NOT NULL;
