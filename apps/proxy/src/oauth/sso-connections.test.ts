import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted (not plain top-level consts) so these are guaranteed
// initialized before vitest invokes the vi.mock factories below --
// several factories reference these mock fns directly as property values
// (not wrapped in a nested closure), which vitest's mock-hoisting can
// otherwise evaluate ahead of a plain `const x = vi.fn()` declaration.
const { queryMock, encryptMock, decryptMock, safeFetchMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  encryptMock: vi.fn(async (s: string) => `enc:${s}`),
  decryptMock: vi.fn(async (s: string) => s.replace(/^enc:/, '')),
  safeFetchMock: vi.fn(),
}));

vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: queryMock }) }));

vi.mock('../billing/provider-key-crypto.js', () => ({
  encryptProviderKey: encryptMock,
  decryptProviderKey: decryptMock,
}));

vi.mock('../plugins/safe-fetch.js', () => ({
  safeFetch: safeFetchMock,
  FileUrlBlockedError: class FileUrlBlockedError extends Error {},
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

import {
  createIdpConfig,
  updateIdpConfig,
  deleteIdpConfig,
  resolveIdpConfigByDomain,
  resolveIdpConfigById,
  validateIssuerViaDiscovery,
  IdpConfigDomainConflictError,
  UnsafeIssuerError,
  SsoDeviceFlowDisabledError,
  IdpSecretDecryptionError,
} from './sso-connections.js';

const validDiscoveryBody = JSON.stringify({
  issuer: 'https://accounts.example.com',
  authorization_endpoint: 'https://accounts.example.com/authorize',
  token_endpoint: 'https://accounts.example.com/token',
  jwks_uri: 'https://accounts.example.com/jwks',
});

describe('validateIssuerViaDiscovery — endpoint scheme validation', () => {
  beforeEach(() => safeFetchMock.mockReset());

  function discoveryWith(overrides: Record<string, string>): string {
    return JSON.stringify({
      issuer: 'https://accounts.example.com',
      authorization_endpoint: 'https://accounts.example.com/authorize',
      token_endpoint: 'https://accounts.example.com/token',
      jwks_uri: 'https://accounts.example.com/jwks',
      ...overrides,
    });
  }

  it('rejects a discovery doc whose authorization_endpoint is a javascript: URL (XSS sink defense)', async () => {
    // authorization_endpoint flows to the verify page's window.location.href;
    // a javascript:-scheme value would execute on the proxy origin. It is never
    // passed through safeFetch, so this is its only scheme gate.
    safeFetchMock.mockResolvedValue({
      statusCode: 200, headers: {},
      body: Buffer.from(discoveryWith({ authorization_endpoint: 'javascript:alert(document.domain)//' })),
    });
    await expect(validateIssuerViaDiscovery('https://accounts.example.com')).rejects.toThrow(UnsafeIssuerError);
  });

  it('rejects a discovery doc whose endpoints use a non-https scheme (http://, data:, etc.)', async () => {
    safeFetchMock.mockResolvedValue({
      statusCode: 200, headers: {},
      body: Buffer.from(discoveryWith({ token_endpoint: 'http://accounts.example.com/token' })),
    });
    await expect(validateIssuerViaDiscovery('https://accounts.example.com')).rejects.toThrow(UnsafeIssuerError);
  });

  it('accepts a fully https discovery document', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(discoveryWith({})) });
    const doc = await validateIssuerViaDiscovery('https://accounts.example.com');
    expect(doc.authorization_endpoint).toBe('https://accounts.example.com/authorize');
  });
});

describe('createIdpConfig', () => {
  beforeEach(() => {
    queryMock.mockReset();
    encryptMock.mockClear();
    safeFetchMock.mockReset();
    vi.stubEnv('SSO_DEVICE_FLOW_ENABLED', 'true');
  });

  it('refuses to create a connection when SSO_DEVICE_FLOW_ENABLED is not "true" -- the structural rollout gate', async () => {
    vi.stubEnv('SSO_DEVICE_FLOW_ENABLED', '');
    await expect(
      createIdpConfig({
        teamId: 'team-a', provider: 'okta', loginDomain: 'example.com',
        issuer: 'https://accounts.example.com', clientId: 'c', clientSecret: 's',
      }),
    ).rejects.toThrow(SsoDeviceFlowDisabledError);
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('validates the issuer via discovery before saving, encrypts the secret, and inserts', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(validDiscoveryBody) });
    queryMock.mockResolvedValueOnce({ rows: [] }); // INSERT

    const result = await createIdpConfig({
      teamId: 'team-a',
      provider: 'okta',
      loginDomain: 'Example.com',
      issuer: 'https://accounts.example.com',
      clientId: 'client-123',
      clientSecret: 'super-secret',
    });

    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://accounts.example.com/.well-known/openid-configuration',
      expect.anything(),
    );
    expect(encryptMock).toHaveBeenCalledWith('super-secret');
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain('INSERT INTO idp_configs');
    expect(params).toContain('example.com'); // lower-cased before storage, matching the unique index
    expect(params).toContain('enc:super-secret');
    // No-op case: an issuer with no trailing slash is persisted unchanged.
    expect(params).toContain('https://accounts.example.com');
    expect(result.id).toBeTruthy();
  });

  it('normalizes a trailing-slash issuer before persisting it -- validateIssuerViaDiscovery only strips the slash for its own internal discovery-URL/§4.3 check and never returns that value, so a raw trailing-slash issuer would otherwise be stored verbatim and fail every future jose jwtVerify() iss comparison against a real IdP token (RSH-100 codex review)', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(validDiscoveryBody) });
    queryMock.mockResolvedValueOnce({ rows: [] }); // INSERT

    await createIdpConfig({
      teamId: 'team-a',
      provider: 'okta',
      loginDomain: 'example.com',
      issuer: 'https://accounts.example.com/',
      clientId: 'client-123',
      clientSecret: 'super-secret',
    });

    const [, params] = queryMock.mock.calls[0]!;
    expect(params).toContain('https://accounts.example.com');
    expect(params).not.toContain('https://accounts.example.com/');
  });

  it('rejects an issuer that fails discovery (SSRF guard or unreachable) before touching the DB', async () => {
    safeFetchMock.mockRejectedValue(new Error('file_url_blocked'));

    await expect(
      createIdpConfig({
        teamId: 'team-a',
        provider: 'okta',
        loginDomain: 'example.com',
        issuer: 'http://169.254.169.254/',
        clientId: 'client-123',
        clientSecret: 'super-secret',
      }),
    ).rejects.toThrow(UnsafeIssuerError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('maps a domain-uniqueness collision to a typed error, not a raw DB error', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(validDiscoveryBody) });
    const dbError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'idx_idp_configs_login_domain',
    });
    queryMock.mockRejectedValueOnce(dbError);

    await expect(
      createIdpConfig({
        teamId: 'team-a',
        provider: 'okta',
        loginDomain: 'example.com',
        issuer: 'https://accounts.example.com',
        clientId: 'client-123',
        clientSecret: 'super-secret',
      }),
    ).rejects.toThrow(IdpConfigDomainConflictError);
  });

  it('rethrows a 23505 on the primary key (not the domain index) as-is, not misreported as a domain conflict', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(validDiscoveryBody) });
    const dbError = Object.assign(new Error('duplicate key value violates unique constraint "idp_configs_pkey"'), {
      code: '23505',
      constraint: 'idp_configs_pkey',
    });
    queryMock.mockRejectedValueOnce(dbError);

    await expect(
      createIdpConfig({
        teamId: 'team-a',
        provider: 'okta',
        loginDomain: 'example.com',
        issuer: 'https://accounts.example.com',
        clientId: 'client-123',
        clientSecret: 'super-secret',
      }),
    ).rejects.toThrow(dbError);
  });

  it('rejects an issuer containing a query string with a clear error, before ever calling safeFetch', async () => {
    await expect(
      createIdpConfig({
        teamId: 'team-a',
        provider: 'okta',
        loginDomain: 'example.com',
        issuer: 'https://accounts.example.com?foo=bar',
        clientId: 'client-123',
        clientSecret: 'super-secret',
      }),
    ).rejects.toThrow(UnsafeIssuerError);
    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects a discovery document whose issuer does not match the requested issuer (OIDC Discovery 1.0 §4.3 anti-mix-up check)', async () => {
    const mismatchedIssuerBody = JSON.stringify({
      issuer: 'https://evil.example.com',
      authorization_endpoint: 'https://accounts.example.com/authorize',
      token_endpoint: 'https://accounts.example.com/token',
      jwks_uri: 'https://accounts.example.com/jwks',
    });
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(mismatchedIssuerBody) });

    await expect(
      createIdpConfig({
        teamId: 'team-a',
        provider: 'okta',
        loginDomain: 'example.com',
        issuer: 'https://accounts.example.com',
        clientId: 'client-123',
        clientSecret: 'super-secret',
      }),
    ).rejects.toThrow(UnsafeIssuerError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects when discovery succeeds but returns a non-200 status code', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 500, headers: {}, body: Buffer.from(validDiscoveryBody) });

    await expect(
      createIdpConfig({
        teamId: 'team-a',
        provider: 'okta',
        loginDomain: 'example.com',
        issuer: 'https://accounts.example.com',
        clientId: 'client-123',
        clientSecret: 'super-secret',
      }),
    ).rejects.toThrow(UnsafeIssuerError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects when discovery succeeds with a non-JSON body', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from('this is not json') });

    await expect(
      createIdpConfig({
        teamId: 'team-a',
        provider: 'okta',
        loginDomain: 'example.com',
        issuer: 'https://accounts.example.com',
        clientId: 'client-123',
        clientSecret: 'super-secret',
      }),
    ).rejects.toThrow(UnsafeIssuerError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects when the discovery document JSON is missing a required field (jwks_uri)', async () => {
    const incompleteBody = JSON.stringify({
      issuer: 'https://accounts.example.com',
      authorization_endpoint: 'https://accounts.example.com/authorize',
      token_endpoint: 'https://accounts.example.com/token',
      // jwks_uri intentionally omitted
    });
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(incompleteBody) });

    await expect(
      createIdpConfig({
        teamId: 'team-a',
        provider: 'okta',
        loginDomain: 'example.com',
        issuer: 'https://accounts.example.com',
        clientId: 'client-123',
        clientSecret: 'super-secret',
      }),
    ).rejects.toThrow(UnsafeIssuerError);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('updateIdpConfig', () => {
  beforeEach(() => {
    queryMock.mockReset();
    safeFetchMock.mockReset();
    encryptMock.mockClear();
  });

  it('re-validates a changed issuer and scopes the UPDATE to id + team_id', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(validDiscoveryBody) });
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    await updateIdpConfig('conn-1', 'team-a', { issuer: 'https://accounts.example.com' });

    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain('WHERE id = ');
    expect(String(sql)).toContain('team_id = ');
    expect(params).toContain('conn-1');
    expect(params).toContain('team-a');
  });

  it('normalizes a trailing-slash issuer before persisting it in the UPDATE (RSH-100 codex review, same bug as createIdpConfig)', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(validDiscoveryBody) });
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    await updateIdpConfig('conn-1', 'team-a', { issuer: 'https://accounts.example.com/' });

    const [, params] = queryMock.mock.calls[0]!;
    expect(params).toContain('https://accounts.example.com');
    expect(params).not.toContain('https://accounts.example.com/');
  });

  it('returns not-found (not a generic error) when the id/team_id pair matches no row', async () => {
    safeFetchMock.mockResolvedValue({ statusCode: 200, headers: {}, body: Buffer.from(validDiscoveryBody) });
    queryMock.mockResolvedValueOnce({ rowCount: 0 });

    const result = await updateIdpConfig('conn-nonexistent', 'team-a', { issuer: 'https://accounts.example.com' });
    expect(result).toBe(false);
  });

  it('changing only clientSecret does not re-check discovery, but does encrypt and update the right column', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    const result = await updateIdpConfig('conn-1', 'team-a', { clientSecret: 'new-secret' });

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(encryptMock).toHaveBeenCalledWith('new-secret');
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain('client_secret_encrypted = $');
    expect(String(sql)).not.toContain('issuer = $');
    expect(String(sql)).not.toContain('client_id = $');
    expect(params).toContain('enc:new-secret');
    expect(result).toBe(true);
  });
});

describe('deleteIdpConfig', () => {
  it('scopes the DELETE to id + team_id, never leaking existence across teams', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rowCount: 1 });

    const result = await deleteIdpConfig('conn-1', 'team-a');

    expect(result).toBe(true);
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain('WHERE id = ');
    expect(String(sql)).toContain('team_id = ');
    expect(params).toEqual(['conn-1', 'team-a']);
  });
});

describe('resolveIdpConfigByDomain', () => {
  it('returns the config (including login_domain) when found and the team is not suspended', async () => {
    queryMock.mockReset();
    decryptMock.mockClear();
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'idp-1', team_id: 'team-a', provider: 'okta', login_domain: 'example.com', issuer: 'https://accounts.example.com', client_id: 'client-1', client_secret_encrypted: 'enc:secret-1' }],
    });

    const result = await resolveIdpConfigByDomain('example.com');

    expect(result?.loginDomain).toBe('example.com');
    expect(result?.clientSecret).toBe('secret-1');
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain('t.is_suspended = false');
    expect(params).toEqual(['example.com']);
  });

  it('returns null for a domain no team has registered', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await resolveIdpConfigByDomain('nobody-has-this.com')).toBeNull();
  });

  it('throws a typed IdpSecretDecryptionError (not a raw Error) when decryption fails', async () => {
    queryMock.mockReset();
    decryptMock.mockClear();
    decryptMock.mockRejectedValueOnce(
      new Error('Failed to decrypt provider key with any available secret'),
    );
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'idp-1', team_id: 'team-a', provider: 'okta', login_domain: 'example.com', issuer: 'https://accounts.example.com', client_id: 'client-1', client_secret_encrypted: 'enc:secret-1' }],
    });

    let caught: unknown;
    try {
      await resolveIdpConfigByDomain('example.com');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IdpSecretDecryptionError);
    expect((caught as IdpSecretDecryptionError).idpConfigId).toBe('idp-1');
  });
});

describe('resolveIdpConfigById', () => {
  it('returns the config with a decrypted secret when found and the team is not suspended', async () => {
    queryMock.mockReset();
    decryptMock.mockClear();
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'idp-1', team_id: 'team-a', provider: 'okta', login_domain: 'example.com', issuer: 'https://accounts.example.com', client_id: 'client-1', client_secret_encrypted: 'enc:secret-1' }],
    });

    const result = await resolveIdpConfigById('idp-1');

    expect(result?.clientSecret).toBe('secret-1');
    expect(decryptMock).toHaveBeenCalledWith('enc:secret-1');
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(String(sql)).toContain('t.is_suspended = false');
    expect(params).toEqual(['idp-1']);
  });

  it('returns null when no row matches (including a suspended team, via the JOIN)', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [] });

    const result = await resolveIdpConfigById('idp-nonexistent');

    expect(result).toBeNull();
  });

  it('throws a typed IdpSecretDecryptionError (not a raw Error) when decryption fails', async () => {
    queryMock.mockReset();
    decryptMock.mockClear();
    decryptMock.mockRejectedValueOnce(
      new Error('Failed to decrypt provider key with any available secret'),
    );
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'idp-1', team_id: 'team-a', provider: 'okta', login_domain: 'example.com', issuer: 'https://accounts.example.com', client_id: 'client-1', client_secret_encrypted: 'enc:secret-1' }],
    });

    let caught: unknown;
    try {
      await resolveIdpConfigById('idp-1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IdpSecretDecryptionError);
    expect((caught as IdpSecretDecryptionError).idpConfigId).toBe('idp-1');
  });
});
