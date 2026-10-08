-- 051-team-data-keys.sql
-- RSH-88 Phase 1: per-team envelope-encryption foundation.
-- team_id is TEXT (RouteShift tenant-id invariant — never uuid).

CREATE TABLE IF NOT EXISTS team_data_keys (
  team_id       TEXT NOT NULL,
  dek_version   INTEGER NOT NULL CHECK (dek_version > 0),
  wrapped_dek   BYTEA NOT NULL,
  kek_provider  TEXT NOT NULL,
  kek_key_ref   TEXT NOT NULL,
  context_version SMALLINT NOT NULL DEFAULT 1,
  status        TEXT NOT NULL CHECK (status IN ('active', 'retiring', 'retired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ,
  retired_at    TIMESTAMPTZ,
  PRIMARY KEY (team_id, dek_version)
);

-- Exactly one active DEK per team.
CREATE UNIQUE INDEX IF NOT EXISTS team_data_keys_one_active
  ON team_data_keys (team_id) WHERE status = 'active';

-- Provider-key metadata for scheme dispatch and DEK version linkage.
-- Nullable during dual-read; existing rows receive classification by payload
-- inspection, not by these columns.
ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS encryption_scheme TEXT,
  ADD COLUMN IF NOT EXISTS encryption_key_version INTEGER;

-- FK from provider_keys to team_data_keys (composite tenant key).
-- Added as NOT VALID to avoid scanning existing rows; validated after backfill.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_keys_team_dek_fk'
  ) THEN
    ALTER TABLE provider_keys
      ADD CONSTRAINT provider_keys_team_dek_fk
      FOREIGN KEY (team_id, encryption_key_version)
      REFERENCES team_data_keys (team_id, dek_version)
      NOT VALID;
  END IF;
END $$;
