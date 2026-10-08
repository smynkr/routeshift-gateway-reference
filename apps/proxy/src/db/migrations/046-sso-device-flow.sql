-- 046-sso-device-flow.sql
-- RSH-100: native SSO device-flow key issuance (RFC 8628), scoped to
-- Google Workspace + Okta. New, separate flow from the dashboard's RTSH-1
-- device flow (oauth_device_authorizations) -- this one lives in
-- apps/proxy/src/oauth/, resolves team via home-realm discovery at
-- device-code-issuance time (not at approval time), and mints
-- short-lived (default 8h) keys instead of long-lived ones.
--
-- See docs/superpowers/specs/2026-07-08-rsh-100-native-sso-device-flow-design.md
-- for the full design and three rounds of review that produced this schema.

-- ---------------------------------------------------------------------------
-- Per-team IdP connections. One row per (team, domain) -- a team may
-- register multiple domains and/or providers, but a domain belongs to
-- exactly one team (enforced by the unique index below, not a table
-- constraint -- Postgres doesn't allow expressions in table-level UNIQUE).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idp_configs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_workspace', 'okta')),
  login_domain TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_idp_configs_team ON idp_configs(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idp_configs_login_domain
  ON idp_configs (lower(login_domain));

-- ---------------------------------------------------------------------------
-- Device authorization requests for the SSO flow. team_id is resolved at
-- CREATE time (home-realm discovery), not at approval -- this is what makes
-- redirecting to the *correct* IdP possible before the browser leg starts.
-- device_code is stored only as a sha256 hash (bearer secret); user_code is
-- low-entropy and human-typed, stored in clear, uniqueness scoped to only
-- while it's actually pending (see index below).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_authorizations (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  idp_config_id TEXT NOT NULL REFERENCES idp_configs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  oauth_state TEXT,
  oidc_nonce TEXT,
  verified_email TEXT,
  consumed_at TIMESTAMPTZ,
  interval_seconds INTEGER NOT NULL DEFAULT 5,
  last_polled_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_auth_user_code
  ON device_authorizations(user_code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_device_auth_expires
  ON device_authorizations(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_auth_oauth_state
  ON device_authorizations(oauth_state) WHERE oauth_state IS NOT NULL;

-- ---------------------------------------------------------------------------
-- One live SSO-issued key per (team, email). FOR UPDATE alone can't
-- serialize this (it only locks rows that already exist), so it's enforced
-- here at the database level: a second concurrent INSERT for the same
-- identity fails this constraint instead of silently succeeding.
-- Index-only change -- no columns added to api_keys.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_one_live_sso_per_identity
  ON api_keys (team_id, lower(metadata->>'email'))
  WHERE revoked_at IS NULL AND metadata->>'issued_via' = 'sso_device_flow';

-- ---------------------------------------------------------------------------
-- Audit event_type CHECK fix. The TS union in auth/audit-events.ts already
-- has 'rotated', but this DB constraint (added in 025) was never updated to
-- match -- every rotation's audit insert has been silently failing this
-- constraint since rotation shipped (LAY-339). Fixing it here because this
-- migration is already rewriting this exact constraint to add 'sso_issued';
-- leaving 'rotated' out again would be re-committing the same bug in the
-- same statement.
-- ---------------------------------------------------------------------------
ALTER TABLE api_key_audit_events DROP CONSTRAINT IF EXISTS api_key_audit_events_event_type_values;
ALTER TABLE api_key_audit_events ADD CONSTRAINT api_key_audit_events_event_type_values
  CHECK (event_type IN ('created', 'revoked', 'rotated', 'auth_failed', 'rate_limited', 'budget_exceeded', 'sso_issued'));
