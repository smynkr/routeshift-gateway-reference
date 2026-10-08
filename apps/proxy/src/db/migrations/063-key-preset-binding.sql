-- 063-key-preset-binding.sql
-- RSH-146: a key can be minted ALREADY bound to a preset — org policy applied
-- at issuance instead of later or never. Additive: two nullable columns.
-- preset_slug references presets by slug (team-scoped at resolve time);
-- preset_version optionally pins a version (NULL = latest enabled).
-- Enforcement is fail-closed in proxy-handler: a bound key applies the
-- preset on every request (request-supplied presets conflict with 400), and
-- a deleted/disabled preset makes the key fail with 403 rather than falling
-- back to an unbound key.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS preset_slug TEXT,
  ADD COLUMN IF NOT EXISTS preset_version INTEGER;

-- A version without a slug is meaningless.
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_preset_version_requires_slug;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_preset_version_requires_slug
  CHECK (preset_version IS NULL OR preset_slug IS NOT NULL);
