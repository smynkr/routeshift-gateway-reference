-- 029-teams-tpm-limit.sql
-- LAY-348: workspace-level tokens-per-minute cap. Runs in series with the
-- per-key TPM cap shipped in LAY-330: a key with its own override gets its
-- own bucket *and* still consumes against the team bucket. NULL means "no
-- team cap", which is the existing behaviour.

ALTER TABLE teams ADD COLUMN IF NOT EXISTS tpm_limit integer;

ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_tpm_limit_positive;
ALTER TABLE teams ADD CONSTRAINT teams_tpm_limit_positive
  CHECK (tpm_limit IS NULL OR tpm_limit > 0);
