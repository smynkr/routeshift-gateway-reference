// apps/proxy/src/oauth/sso-connections.ts
// RSH-100: idp_configs data access. Validates issuer via SSRF-safe
// discovery fetch before every write (create or issuer-changing update) --
// issuer is team-supplied and used for server-side HTTP fetches downstream
// (OIDC client, in a later task), so it goes through the same SSRF guard
// (apps/proxy/src/plugins/safe-fetch.ts) already used elsewhere in this
// app for exactly this class of risk. client_secret reuses the existing
// AES-256-GCM envelope from billing/provider-key-crypto.ts -- same app,
// no new crypto code needed.
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { encryptProviderKey, decryptProviderKey } from '../billing/provider-key-crypto.js';
import { safeFetch } from '../plugins/safe-fetch.js';

export type IdpProvider = 'google_workspace' | 'okta';

export class UnsafeIssuerError extends Error {
  constructor(issuer: string, public readonly cause?: unknown) {
    super(`issuer failed SSRF/discovery validation: ${issuer}`);
    this.name = 'UnsafeIssuerError';
  }
}

export class IdpConfigDomainConflictError extends Error {
  constructor(public readonly domain: string) {
    super(`login_domain already registered to another team: ${domain}`);
    this.name = 'IdpConfigDomainConflictError';
  }
}

export class SsoDeviceFlowDisabledError extends Error {
  constructor() {
    super('SSO device-flow login is not enabled in this environment');
    this.name = 'SsoDeviceFlowDisabledError';
  }
}

// decryptProviderKey() throws a plain, untyped Error on bad ciphertext or a
// rotated-secret mismatch. Wrap it in a typed error here so it fits this
// file's pattern of errors callers can branch on (UnsafeIssuerError,
// IdpConfigDomainConflictError, SsoDeviceFlowDisabledError).
export class IdpSecretDecryptionError extends Error {
  constructor(public readonly idpConfigId: string, public readonly cause?: unknown) {
    super(`failed to decrypt client_secret for idp_configs row ${idpConfigId}`);
    this.name = 'IdpSecretDecryptionError';
  }
}

// RSH-100 rollout gate: SSO login must not be enabled for any real team
// until the companion Axiom Layer reconciliation-sync ticket is live in
// the same environment -- otherwise admin-driven bulk-provisioning
// double-mints on top of self-expiring SSO keys. Structural, not just
// documented: creating an idp_configs row (the only way SSO ever gets
// enabled for a team) requires this flag, which defaults OFF.
function assertSsoDeviceFlowEnabled(): void {
  if (process.env.SSO_DEVICE_FLOW_ENABLED !== 'true') {
    throw new SsoDeviceFlowDisabledError();
  }
}

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Fetch and minimally validate the OIDC discovery document via the SSRF
 * guard. Throws UnsafeIssuerError on any failure (blocked host, network
 * error, non-200, malformed body, missing fields, or an issuer mismatch --
 * see the OIDC Discovery 1.0 §4.3 check below). */
export async function validateIssuerViaDiscovery(issuer: string): Promise<OidcDiscoveryDocument> {
  // A query string or fragment silently breaks the .well-known URL
  // construction below (only trailing slashes are stripped), and would
  // otherwise surface as an opaque discovery-failure UnsafeIssuerError.
  if (issuer.includes('?') || issuer.includes('#')) {
    throw new UnsafeIssuerError(issuer, new Error('issuer must not contain a query string or fragment'));
  }
  const normalizedIssuer = issuer.replace(/\/+$/, '');
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
  let res;
  try {
    res = await safeFetch(discoveryUrl, { method: 'GET' });
  } catch (err) {
    throw new UnsafeIssuerError(issuer, err);
  }
  if (res.statusCode !== 200) {
    throw new UnsafeIssuerError(issuer, new Error(`discovery returned ${res.statusCode}`));
  }
  let doc: OidcDiscoveryDocument;
  try {
    doc = JSON.parse(res.body.toString('utf-8'));
  } catch (err) {
    throw new UnsafeIssuerError(issuer, err);
  }
  if (
    typeof doc.issuer !== 'string' ||
    typeof doc.authorization_endpoint !== 'string' ||
    typeof doc.token_endpoint !== 'string' ||
    typeof doc.jwks_uri !== 'string'
  ) {
    throw new UnsafeIssuerError(issuer, new Error('discovery document missing required fields'));
  }
  // Every endpoint must be https. token_endpoint and jwks_uri are later passed
  // through safeFetch (which enforces http/https + SSRF), but authorization_
  // endpoint is NEVER fetched -- it flows into buildAuthorizationUrl and out to
  // the verify page's `window.location.href`, so a `javascript:`/`data:` value
  // would execute on the proxy origin (XSS). This is that field's only scheme
  // gate; require https for all three uniformly so a poisoned discovery doc
  // (re-fetched on every approve) can't smuggle a script-scheme redirect.
  for (const endpoint of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new UnsafeIssuerError(issuer, new Error(`discovery document endpoint is not a valid URL: ${endpoint}`));
    }
    if (parsed.protocol !== 'https:') {
      throw new UnsafeIssuerError(issuer, new Error(`discovery document endpoint must be https: ${endpoint}`));
    }
  }
  // OIDC Discovery 1.0 §4.3: the "issuer" returned in the discovery
  // document MUST be identical to the issuer URL used to fetch it. This is
  // the standard defense against issuer-confusion/mix-up attacks (an
  // attacker-controlled or compromised discovery endpoint claiming to speak
  // for a different issuer). Normalize trailing slashes on both sides
  // before comparing so a bare vs. slash-terminated issuer isn't a
  // false-positive mismatch.
  if (doc.issuer.replace(/\/+$/, '') !== normalizedIssuer) {
    throw new UnsafeIssuerError(
      issuer,
      new Error('discovery document issuer does not match requested issuer'),
    );
  }
  return doc;
}

export interface CreateIdpConfigInput {
  teamId: string;
  provider: IdpProvider;
  loginDomain: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

export async function createIdpConfig(input: CreateIdpConfigInput): Promise<{ id: string }> {
  assertSsoDeviceFlowEnabled();
  await validateIssuerViaDiscovery(input.issuer);
  // validateIssuerViaDiscovery strips trailing slashes only for its own
  // internal discovery-URL construction and §4.3 comparison -- it never
  // hands that normalized value back to the caller. Persisting input.issuer
  // as-is would store a trailing-slash issuer that a real IdP's tokens never
  // carry in their `iss` claim (jose's jwtVerify does a byte-for-byte
  // match), permanently failing every login for this team. Normalize the
  // same way here before it ever reaches the DB.
  const normalizedIssuer = input.issuer.replace(/\/+$/, '');

  const encrypted = await encryptProviderKey(input.clientSecret);
  const id = `idp_${randomUUID().slice(0, 8)}`;
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO idp_configs (id, team_id, provider, login_domain, issuer, client_id, client_secret_encrypted)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, input.teamId, input.provider, input.loginDomain.toLowerCase(), normalizedIssuer, input.clientId, encrypted],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      // Only the domain unique-index violation is an actual domain
      // conflict; a collision on idp_configs_pkey (the randomUUID-derived
      // id) is astronomically unlikely and should not be misreported as
      // one.
      const constraint = (err as { constraint?: string }).constraint;
      if (constraint === 'idx_idp_configs_login_domain') {
        throw new IdpConfigDomainConflictError(input.loginDomain);
      }
    }
    throw err;
  }
  return { id };
}

export interface UpdateIdpConfigInput {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Returns false if no row matched (id, team_id) -- caller maps that to 404. */
export async function updateIdpConfig(
  id: string,
  teamId: string,
  input: UpdateIdpConfigInput,
): Promise<boolean> {
  // See createIdpConfig's comment: validateIssuerViaDiscovery normalizes
  // trailing slashes only internally and never returns that value, so this
  // computes and persists the same normalized form itself.
  let normalizedIssuer: string | undefined;
  if (input.issuer !== undefined) {
    await validateIssuerViaDiscovery(input.issuer);
    normalizedIssuer = input.issuer.replace(/\/+$/, '');
  }

  const sets: string[] = [];
  const params: unknown[] = [id, teamId];
  if (normalizedIssuer !== undefined) {
    params.push(normalizedIssuer);
    sets.push(`issuer = $${params.length}`);
  }
  if (input.clientId !== undefined) {
    params.push(input.clientId);
    sets.push(`client_id = $${params.length}`);
  }
  if (input.clientSecret !== undefined) {
    params.push(await encryptProviderKey(input.clientSecret));
    sets.push(`client_secret_encrypted = $${params.length}`);
  }
  if (sets.length === 0) return true;

  const { rowCount } = await getPool().query(
    `UPDATE idp_configs SET ${sets.join(', ')} WHERE id = $1 AND team_id = $2`,
    params,
  );
  return (rowCount ?? 0) > 0;
}

/** Returns false if no row matched (id, team_id) -- caller maps that to 404. */
export async function deleteIdpConfig(id: string, teamId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM idp_configs WHERE id = $1 AND team_id = $2`,
    [id, teamId],
  );
  return (rowCount ?? 0) > 0;
}

export interface ResolvedIdpConfig {
  id: string;
  teamId: string;
  provider: IdpProvider;
  loginDomain: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
}

async function rowToResolvedIdpConfig(row: {
  id: string; team_id: string; provider: IdpProvider; login_domain: string;
  issuer: string; client_id: string; client_secret_encrypted: string;
}): Promise<ResolvedIdpConfig> {
  let clientSecret: string;
  try {
    clientSecret = await decryptProviderKey(row.client_secret_encrypted);
  } catch (err) {
    throw new IdpSecretDecryptionError(row.id, err);
  }
  return {
    id: row.id,
    teamId: row.team_id,
    provider: row.provider,
    loginDomain: row.login_domain,
    issuer: row.issuer,
    clientId: row.client_id,
    clientSecret,
  };
}

const RESOLVED_CONFIG_COLUMNS =
  'ic.id, ic.team_id, ic.provider, ic.login_domain, ic.issuer, ic.client_id, ic.client_secret_encrypted';

/** Home-realm discovery: resolve a login_domain to its team's IdP config,
 * decrypting the client secret. Returns null if no team has registered
 * this domain OR the team is suspended. */
export async function resolveIdpConfigByDomain(loginDomain: string): Promise<ResolvedIdpConfig | null> {
  const { rows } = await getPool().query(
    `SELECT ${RESOLVED_CONFIG_COLUMNS}
       FROM idp_configs ic
       JOIN teams t ON t.id = ic.team_id
      WHERE lower(ic.login_domain) = lower($1) AND t.is_suspended = false
      LIMIT 1`,
    [loginDomain],
  );
  const row = rows[0];
  return row ? rowToResolvedIdpConfig(row) : null;
}

/** Resolve a specific idp_configs row by id — used at /verify and
 * /callback time, where the team/domain lookup already happened at
 * /oauth/device/code time and shouldn't be repeated. */
export async function resolveIdpConfigById(id: string): Promise<ResolvedIdpConfig | null> {
  const { rows } = await getPool().query(
    `SELECT ${RESOLVED_CONFIG_COLUMNS}
       FROM idp_configs ic
       JOIN teams t ON t.id = ic.team_id
      WHERE ic.id = $1 AND t.is_suspended = false
      LIMIT 1`,
    [id],
  );
  const row = rows[0];
  return row ? rowToResolvedIdpConfig(row) : null;
}
