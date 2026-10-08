-- 037-team-id-text-consistency.sql
-- Align tenant-scoped team_id columns with teams.id, which is TEXT and includes
-- self-serve ids such as team_ab12cd34. Do not alter genuine UUID identifiers
-- such as optimize_findings.id or teams.layer_tenant_id.

ALTER TABLE model_aliases
  ALTER COLUMN team_id TYPE text USING team_id::text;

ALTER TABLE team_budgets
  ALTER COLUMN team_id TYPE text USING team_id::text;

ALTER TABLE team_provider_strategies
  ALTER COLUMN team_id TYPE text USING team_id::text;

ALTER TABLE optimize_findings
  ALTER COLUMN team_id TYPE text USING team_id::text;
