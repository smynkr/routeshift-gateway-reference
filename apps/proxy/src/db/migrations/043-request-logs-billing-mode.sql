ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS billing_mode varchar(20) NOT NULL DEFAULT 'subscription';
