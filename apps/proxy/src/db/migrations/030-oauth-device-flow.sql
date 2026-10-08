-- 030-oauth-device-flow.sql
-- RTSH-1: "Sign in with RouteShift" — OAuth 2.0 Device Authorization Grant
-- (RFC 8628). A browserless auth primitive so a CLI / IDE / extension can
-- authenticate a user and receive a *scoped, short-lived* RouteShift key
-- without anyone copy-pasting a long-lived secret.
--
-- This flips key provisioning from admin-push to self-serve pull, gated by
-- SSO + an org email-domain allowlist (allowed_email_domains). The minted
-- key is identity-scoped (a normal team key, NOT an org-wide admin secret),
-- recorded in key_identities for admin visibility, and revocable through the
-- existing /admin/keys/:id Revoke path.

-- ---------------------------------------------------------------------------
-- Device authorization requests. One row per POST /oauth/device/code.
--
-- device_code is the high-entropy bearer secret the client polls with; it is
-- stored ONLY as a sha256 hash, never in clear. user_code is the short,
-- human-typed code shown on the device and entered in the browser — it is
-- low-entropy by design, single-use, and short-lived, so it is stored in
-- clear because the verification page must look the request up by it.
--
-- The minted key's plaintext secret is NEVER stored here. Minting is deferred
-- to the first successful token poll after approval, so the secret flows
-- straight through the token response and only its id (api_key_id) is kept.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired')),

  -- Identity, populated when a signed-in user approves the request.
  team_id TEXT REFERENCES teams(id),
  user_id TEXT REFERENCES users(id),
  user_email TEXT,

  -- The key minted on first post-approval poll. id only — the secret is
  -- returned once in the token response and never persisted.
  api_key_id TEXT,

  interval_seconds INTEGER NOT NULL DEFAULT 5,
  last_polled_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pending lookups go by user_code (verification page) and device_code_hash
-- (token poll). expires_at index supports the lazy-expiry sweep.
CREATE INDEX IF NOT EXISTS idx_oauth_device_user_code
  ON oauth_device_authorizations(user_code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_oauth_device_expires
  ON oauth_device_authorizations(expires_at);

-- ---------------------------------------------------------------------------
-- Email-domain allowlist that gates self-provisioning. A signed-in user may
-- approve a device authorization (and thereby mint a key for their team) only
-- if their email's domain is allowlisted for that team.
--
-- Fail closed: a team with no rows here cannot self-provision at all — an
-- admin must opt the org in. This only gates the device-flow self-serve
-- path; admin-push key creation (POST /admin/keys) is unaffected.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allowed_email_domains (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  domain TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_allowed_email_domains_team
  ON allowed_email_domains(team_id);

-- ---------------------------------------------------------------------------
-- Identity -> key mapping (the local equivalent of Layer's ai_keys_to_identity).
-- Records which human a self-provisioned key belongs to so admins keep
-- visibility and the existing Revoke path stays the single source of truth
-- for key lifecycle. The key row itself lives in api_keys; this is metadata.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS key_identities (
  api_key_id TEXT PRIMARY KEY REFERENCES api_keys(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  user_id TEXT REFERENCES users(id),
  email TEXT,
  created_via TEXT NOT NULL DEFAULT 'oauth_device',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_key_identities_user
  ON key_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_key_identities_team
  ON key_identities(team_id);

-- RSH-59: the team_dev self-provision email-domain allowlist moved to the
-- dev-only bootstrap (db/migrate.ts applyDevSeed), applied only outside
-- production. It used to be seeded here unconditionally, letting the seeded
-- prod admin self-provision keys. Production teams opt in explicitly.
