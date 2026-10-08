-- 022-model-aliases.sql
-- LAY-318: per-team model aliases. Lets a team register
--   myorg-gpt5-eastus → gpt-5
-- so Azure deployment names (and OpenAI fine-tunes like ft:gpt-4o:org::abc)
-- route + price as the canonical model. Provider is intentionally absent —
-- aliases resolve only the model identity; provider is still inferred from
-- routing rules and provider keys.

CREATE TABLE IF NOT EXISTS model_aliases (
  team_id uuid NOT NULL,
  alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 200),
  canonical_name text NOT NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_model_aliases_team
  ON model_aliases (team_id);
