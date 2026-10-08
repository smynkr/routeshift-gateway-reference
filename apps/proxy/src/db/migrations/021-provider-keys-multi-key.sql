-- 021-provider-keys-multi-key.sql
-- LAY-319: extend provider_keys to support N keys per (team, provider).
-- Existing rows are preserved as the 'default' label with weight=1.
--
-- The new unique constraint is (team_id, provider, label) so every key
-- gets an addressable name within its (team, provider) bucket. Strategy
-- per (team, provider) lives in team_provider_strategies — keeping it on
-- the parent makes "switch from RR to latency-based" a single update.

-- 1. Drop the old single-key unique constraint.
ALTER TABLE provider_keys DROP CONSTRAINT IF EXISTS provider_keys_team_id_provider_key;
DROP INDEX IF EXISTS provider_keys_team_id_provider_idx;

-- 2. Add the multi-key columns.
ALTER TABLE provider_keys
  ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS weight integer NOT NULL DEFAULT 1
    CHECK (weight >= 1 AND weight <= 1000),
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

-- 3. Re-add a unique constraint scoped per-label so a team can have
--    (openai, "primary") and (openai, "secondary") side-by-side.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_keys_team_provider_label_key'
  ) THEN
    ALTER TABLE provider_keys
      ADD CONSTRAINT provider_keys_team_provider_label_key
      UNIQUE (team_id, provider, label);
  END IF;
END $$;

-- 4. Per-(team, provider) selection strategy. Default = weighted_round_robin
--    so single-key teams get the same behavior they had before.
CREATE TABLE IF NOT EXISTS team_provider_strategies (
  team_id uuid NOT NULL,
  provider text NOT NULL,
  strategy text NOT NULL DEFAULT 'weighted_round_robin'
    CHECK (strategy IN ('weighted_round_robin', 'latency_based', 'least_busy')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, provider)
);
