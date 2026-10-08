CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);

-- RSH-59: a dev bootstrap owner account used to be seeded here with a committed
-- bcrypt hash, which made it a live login on the PRODUCTION dashboard. The seed
-- moved to the dev-only bootstrap in db/migrate.ts (applyDevSeed), applied only
-- outside production. (Existing prod databases that already ran this migration
-- must have that seeded row removed and the credential rotated out of band —
-- editing an already-applied migration does not undo it.)
