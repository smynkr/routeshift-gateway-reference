-- 014-provider-keys-metadata.sql
-- (Originally numbered 012 — renamed to 014 to break a numbering collision
-- with 012-promo-codes-and-auto-route.sql that was added concurrently in
-- a parallel session. The migrate runner tracks by filename, so production
-- — which already has a `012-provider-keys-metadata.sql` row in _migrations
-- — will execute this file once more under the new name. The DDL is
-- idempotent (`ADD COLUMN IF NOT EXISTS`), so the re-run is a no-op, but
-- _migrations will end up with rows for BOTH names. New environments only
-- ever see and record the 014 name. If you ever amend this file, ensure the
-- amendment is idempotent for that reason.)
--
-- Adds a metadata jsonb column to provider_keys so providers that need
-- structured non-secret config (e.g. Azure: resource_name + api_version,
-- Bedrock: region + access_key_id) can store it alongside the encrypted key.
--
-- The encrypted_key column still holds the actual secret. Metadata is
-- non-secret and stored unencrypted for simpler debugging and config queries.

ALTER TABLE provider_keys ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
