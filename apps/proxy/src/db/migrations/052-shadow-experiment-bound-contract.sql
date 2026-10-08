-- 052-shadow-experiment-bound-contract.sql
-- RSH-85 Phase 1: require explicit execution/spend bounds at the schema layer.
-- team_id remains TEXT (RouteShift tenant-id invariant — never uuid).

-- The API requires each value explicitly. Remove legacy defaults so direct SQL
-- writes cannot silently create an experiment with inherited spend/queue bounds.
ALTER TABLE shadow_experiments
  ALTER COLUMN max_samples DROP DEFAULT,
  ALTER COLUMN deadline_ms DROP DEFAULT,
  ALTER COLUMN max_concurrency DROP DEFAULT,
  ALTER COLUMN max_queue_count DROP DEFAULT,
  ALTER COLUMN max_queue_bytes DROP DEFAULT,
  ALTER COLUMN max_payload_bytes DROP DEFAULT,
  ALTER COLUMN per_run_cap_microcents DROP DEFAULT,
  ALTER COLUMN aggregate_cap_microcents DROP DEFAULT;

-- Quarantine any legacy invalid configuration without inventing usable bounds.
-- Phase 1 has no executor and the API cannot re-enable an experiment, so these
-- rows remain inert until an operator supplies a compliant explicit configuration.
UPDATE shadow_experiments
SET enabled = false,
    disabled_reason = COALESCE(disabled_reason, 'invalid_execution_bound_contract'),
    updated_at = now()
WHERE max_samples < 0
   OR deadline_ms <= 0
   OR max_concurrency <= 0
   OR max_queue_count < 0
   OR max_queue_bytes < 0
   OR max_payload_bytes <= 0
   OR per_run_cap_microcents < 0
   OR aggregate_cap_microcents < per_run_cap_microcents;

-- The quarantine UPDATE above scans legacy rows once to disable invalid configs.
-- NOT VALID then protects all new/changed rows without requiring a separate
-- existing-row validation scan or VALIDATE CONSTRAINT pass during this deploy.
-- The quarantined rows cannot be made active until explicitly remediated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    WHERE constraint_row.conname = 'shadow_experiments_bound_contract'
      AND relation.oid = 'shadow_experiments'::regclass
  ) THEN
    ALTER TABLE shadow_experiments
      ADD CONSTRAINT shadow_experiments_bound_contract
      CHECK (
        max_samples >= 0
        AND deadline_ms > 0
        AND max_concurrency > 0
        AND max_queue_count >= 0
        AND max_queue_bytes >= 0
        AND max_payload_bytes > 0
        AND per_run_cap_microcents >= 0
        AND aggregate_cap_microcents >= per_run_cap_microcents
      ) NOT VALID;
  END IF;
END $$;

-- A NOT VALID CHECK still applies to every later UPDATE of an old row. Disable
-- legacy enabled rows that lack the future enablement consent contract first,
-- so an annotation PATCH cannot surface a raw 23514 constraint error. Keep a
-- prior bound-contract quarantine reason by ordering this after that update:
-- bound-invalid rows are already disabled and therefore excluded here.
UPDATE shadow_experiments
SET enabled = false,
    disabled_reason = 'missing_enablement_consent_contract',
    updated_at = now()
WHERE enabled
  AND NOT COALESCE(
    consent_provider_ack
    AND consent_region_ack
    AND consent_privacy_ack
    AND approved_by IS NOT NULL
    AND btrim(approved_by) <> ''
    AND approved_at IS NOT NULL,
    false
  );

-- A direct SQL write must not bypass the approval records required before an
-- experiment can ever be enabled. The constraint permits inert Phase 1 rows
-- and applies to all future enablement paths without changing the API's
-- deliberate Phase 1 enablement refusal.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    WHERE constraint_row.conname = 'shadow_experiments_enablement_consent_contract'
      AND relation.oid = 'shadow_experiments'::regclass
  ) THEN
    ALTER TABLE shadow_experiments
      ADD CONSTRAINT shadow_experiments_enablement_consent_contract
      CHECK (
        NOT enabled OR (
          consent_provider_ack
          AND consent_region_ack
          AND consent_privacy_ack
          AND approved_by IS NOT NULL
          AND btrim(approved_by) <> ''
          AND approved_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END $$;
