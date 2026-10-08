import { describe, expect, it, vi, beforeEach } from 'vitest';

// Vitest hoists vi.mock() factories above this file's own top-level code, so
// a factory that reaches for a plain `const x = vi.fn()` declared elsewhere
// in the file hits a TDZ ReferenceError the first time the mocked module is
// imported (confirmed empirically: direct references inside the factory
// fail, closures/vi.hoisted() don't). vi.hoisted() is the documented fix --
// it runs before the mock registration, so `mocks.*` is always initialized
// by the time a factory reads it. Same pattern as
// apps/proxy/tests/admin-keys.test.ts's `mocks = vi.hoisted(...)`.
const mocks = vi.hoisted(() => ({
  createIdpConfig: vi.fn(),
  updateIdpConfig: vi.fn(),
  deleteIdpConfig: vi.fn(),
}));
const createIdpConfigMock = mocks.createIdpConfig;
const updateIdpConfigMock = mocks.updateIdpConfig;
const deleteIdpConfigMock = mocks.deleteIdpConfig;

vi.mock('../admin/auth.js', () => ({ requireAdminAuth: vi.fn(() => true) }));
vi.mock('../oauth/sso-connections.js', () => ({
  createIdpConfig: mocks.createIdpConfig,
  updateIdpConfig: mocks.updateIdpConfig,
  deleteIdpConfig: mocks.deleteIdpConfig,
  IdpConfigDomainConflictError: class IdpConfigDomainConflictError extends Error {},
  UnsafeIssuerError: class UnsafeIssuerError extends Error {},
  SsoDeviceFlowDisabledError: class SsoDeviceFlowDisabledError extends Error {},
}));

import { handleCreateIdpConfig, handleUpdateIdpConfig, handleDeleteIdpConfig } from './idp-configs.js';

// Match the request/response mock shape from apps/proxy/src/admin/keys.test.ts
// (read that file first) -- these are illustrative; align field-for-field with
// this app's established convention rather than introducing a second style.
function mockReq(method: string, url: string, body?: unknown) {
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  return {
    method,
    url,
    headers: {},
    resume: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      if (bodyStr) yield Buffer.from(bodyStr);
    },
  } as never;
}

function mockRawReq(method: string, url: string, body: string) {
  return {
    method,
    url,
    headers: {},
    resume: vi.fn(),
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(body);
    },
  } as never;
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: '',
    writeHead(code: number) { this.statusCode = code; },
    end(chunk?: string) { this.body = chunk ?? ''; },
  };
  return res;
}

describe('handleCreateIdpConfig', () => {
  beforeEach(() => {
    createIdpConfigMock.mockReset();
  });

  it('creates a connection and returns 201 with its id', async () => {
    createIdpConfigMock.mockResolvedValue({ id: 'idp_abc12345' });
    const res = mockRes();

    await handleCreateIdpConfig(
      mockReq('POST', '/admin/idp-configs', {
        team_id: 'team-a',
        provider: 'okta',
        login_domain: 'example.com',
        issuer: 'https://accounts.example.com',
        client_id: 'client-1',
        client_secret: 'secret-1',
      }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ id: 'idp_abc12345' });
  });

  it('rejects a missing team_id with 400 before calling createIdpConfig', async () => {
    const res = mockRes();
    await handleCreateIdpConfig(
      mockReq('POST', '/admin/idp-configs', { provider: 'okta', login_domain: 'x.com', issuer: 'https://x.com', client_id: 'c', client_secret: 's' }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(createIdpConfigMock).not.toHaveBeenCalled();
  });

  it('maps a domain conflict to 409', async () => {
    const { IdpConfigDomainConflictError } = await import('../oauth/sso-connections.js');
    createIdpConfigMock.mockRejectedValue(new IdpConfigDomainConflictError('example.com'));
    const res = mockRes();

    await handleCreateIdpConfig(
      mockReq('POST', '/admin/idp-configs', {
        team_id: 'team-a', provider: 'okta', login_domain: 'example.com',
        issuer: 'https://accounts.example.com', client_id: 'c', client_secret: 's',
      }),
      res as never,
    );

    expect(res.statusCode).toBe(409);
  });

  it('maps an unsafe issuer to 400, not 500', async () => {
    const { UnsafeIssuerError } = await import('../oauth/sso-connections.js');
    createIdpConfigMock.mockRejectedValue(new UnsafeIssuerError('http://169.254.169.254/'));
    const res = mockRes();

    await handleCreateIdpConfig(
      mockReq('POST', '/admin/idp-configs', {
        team_id: 'team-a', provider: 'okta', login_domain: 'example.com',
        issuer: 'http://169.254.169.254/', client_id: 'c', client_secret: 's',
      }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
  });

  it('maps the rollout-gate error (SSO_DEVICE_FLOW_ENABLED unset) to 403', async () => {
    const { SsoDeviceFlowDisabledError } = await import('../oauth/sso-connections.js');
    createIdpConfigMock.mockRejectedValue(new SsoDeviceFlowDisabledError());
    const res = mockRes();

    await handleCreateIdpConfig(
      mockReq('POST', '/admin/idp-configs', {
        team_id: 'team-a', provider: 'okta', login_domain: 'example.com',
        issuer: 'https://accounts.example.com', client_id: 'c', client_secret: 's',
      }),
      res as never,
    );

    expect(res.statusCode).toBe(403);
  });

  // RSH-86: mirrors handleCreateKey's cross-check in admin/keys.ts -- if a
  // scoped-admin token's query-string team_id ever disagreed with the POST
  // body's team_id, this must reject rather than create against the body's
  // (possibly foreign) team_id.
  it('rejects a body team_id that disagrees with the query-string team_id with 403, without calling createIdpConfig', async () => {
    const res = mockRes();

    await handleCreateIdpConfig(
      mockReq('POST', '/admin/idp-configs?team_id=team-a', {
        team_id: 'team-b', provider: 'okta', login_domain: 'example.com',
        issuer: 'https://accounts.example.com', client_id: 'c', client_secret: 's',
      }),
      res as never,
    );

    expect(res.statusCode).toBe(403);
    expect(createIdpConfigMock).not.toHaveBeenCalled();
  });
});

describe('handleUpdateIdpConfig', () => {
  it('404s when the id/team_id pair matches no row', async () => {
    updateIdpConfigMock.mockReset();
    updateIdpConfigMock.mockResolvedValue(false);
    const res = mockRes();

    await handleUpdateIdpConfig(
      mockReq('PATCH', '/admin/idp-configs/conn-1?team_id=team-a', { client_secret: 'new-secret' }),
      res as never,
      'conn-1',
    );

    expect(res.statusCode).toBe(404);
  });

  // Regression for the empty-body-PATCH-masks-404 bug: updateIdpConfig's
  // own no-op early return (`sets.length === 0 → return true`) never
  // queries the database, so without this handler-level guard a PATCH with
  // an empty (or all-unrecognized-field) body would 200 for ANY id/team_id
  // pair -- including a nonexistent id or one belonging to a different
  // team -- silently violating the "nonexistent or foreign id -> 404"
  // guarantee. Assert both the 400 and that updateIdpConfig is never
  // reached.
  it('rejects a PATCH with an empty body with 400, without calling updateIdpConfig', async () => {
    updateIdpConfigMock.mockReset();
    const res = mockRes();

    await handleUpdateIdpConfig(
      mockReq('PATCH', '/admin/idp-configs/conn-1?team_id=team-a', {}),
      res as never,
      'conn-1',
    );

    expect(res.statusCode).toBe(400);
    expect(updateIdpConfigMock).not.toHaveBeenCalled();
  });
});

describe('readJsonBody size cap (RSH-100 review fix: bound admin body buffering too)', () => {
  beforeEach(() => {
    createIdpConfigMock.mockReset();
    updateIdpConfigMock.mockReset();
  });

  it('rejects an over-cap create body with 413, drains it, and never calls createIdpConfig', async () => {
    createIdpConfigMock.mockResolvedValue({ id: 'idp_should_not_be_reached' });
    const huge = {
      team_id: 'x'.repeat(70_000), provider: 'okta', login_domain: 'example.com',
      issuer: 'https://accounts.example.com', client_id: 'c', client_secret: 's',
    };
    const req = mockReq('POST', '/admin/idp-configs', huge) as unknown as { resume: ReturnType<typeof vi.fn> };
    const res = mockRes();
    await handleCreateIdpConfig(req as never, res as never);
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'Request body too large' } });
    expect(req.resume).toHaveBeenCalledOnce();
    expect(createIdpConfigMock).not.toHaveBeenCalled();
  });

  it('rejects an over-cap update body with 413 and never calls updateIdpConfig', async () => {
    const req = mockReq('PATCH', '/admin/idp-configs/conn-1?team_id=team-a', {
      client_secret: 'x'.repeat(70_000),
    });
    const res = mockRes();

    await handleUpdateIdpConfig(req, res as never, 'conn-1');

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'Request body too large' } });
    expect(updateIdpConfigMock).not.toHaveBeenCalled();
  });

  it('continues to return 400 for malformed JSON', async () => {
    const res = mockRes();

    await handleCreateIdpConfig(mockRawReq('POST', '/admin/idp-configs', '{'), res as never);

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'Invalid JSON in request body' } });
    expect(createIdpConfigMock).not.toHaveBeenCalled();
  });
});

describe('handleDeleteIdpConfig', () => {
  it('404s when the id/team_id pair matches no row, 204 when it does', async () => {
    deleteIdpConfigMock.mockReset();
    deleteIdpConfigMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const res1 = mockRes();
    await handleDeleteIdpConfig(mockReq('DELETE', '/admin/idp-configs/conn-1?team_id=team-a'), res1 as never, 'conn-1');
    expect(res1.statusCode).toBe(404);

    const res2 = mockRes();
    await handleDeleteIdpConfig(mockReq('DELETE', '/admin/idp-configs/conn-2?team_id=team-a'), res2 as never, 'conn-2');
    expect(res2.statusCode).toBe(204);
  });
});
