-- 010-api-key-metadata.sql
-- Adds a metadata jsonb column to api_keys so external callers (e.g. Axiom Layer)
-- can tag keys with downstream-system identifiers like layer_identity_id without
-- requiring schema changes here for every new field.

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- GIN index so admin queries that filter by metadata->>'layer_identity_id' are
-- not table scans. Partial index keeps it cheap when most keys have empty metadata.
CREATE INDEX IF NOT EXISTS idx_api_keys_metadata ON api_keys USING GIN (metadata)
  WHERE metadata <> '{}'::jsonb;
