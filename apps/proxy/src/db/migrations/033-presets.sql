CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  model TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  system_prompt TEXT,
  provider_prefs JSONB,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  UNIQUE (team_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_presets_team ON presets (team_id, slug);

CREATE TABLE IF NOT EXISTS preset_versions (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  model TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  system_prompt TEXT,
  provider_prefs JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,
  UNIQUE (preset_id, version)
);

CREATE INDEX IF NOT EXISTS idx_preset_versions_lookup ON preset_versions (team_id, preset_id, version DESC);
