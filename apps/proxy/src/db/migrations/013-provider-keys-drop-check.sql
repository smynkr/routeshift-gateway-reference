-- 013-provider-keys-drop-check.sql
-- Drops the hardcoded CHECK constraint on provider_keys.provider that limited
-- the column to the original 5 providers. Provider validation now lives in
-- the application layer (VALID_PROVIDERS in the dashboard API routes), which
-- is where it can keep up with new providers without a migration each time.

ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_provider_check;
