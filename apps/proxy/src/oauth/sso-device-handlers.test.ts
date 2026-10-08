import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.stubEnv('SSO_CALLBACK_BASE_URL', 'https://api.routeshift.io');

// vi.hoisted (not plain top-level consts) so these are guaranteed
// initialized before vitest invokes the vi.mock factories below, which
// reference them directly -- vi.mock calls are hoisted above regular const
// declarations. See src/oauth/sso-device-service.test.ts and
// src/oauth/sso-key-mint.test.ts for the same established pattern in this
// codebase (this bug bit Tasks 8, 9, and 10 independently).
const {
  createSsoDeviceAuthorizationMock,
  getAuthorizationByUserCodeMock,
  bindOAuthStateMock,
  denyAuthorizationMock,
  getAuthorizationByOAuthStateMock,
  approveAuthorizationMock,
  pollDeviceTokenMock,
} = vi.hoisted(() => ({
  createSsoDeviceAuthorizationMock: vi.fn(),
  getAuthorizationByUserCodeMock: vi.fn(),
  bindOAuthStateMock: vi.fn(),
  denyAuthorizationMock: vi.fn(),
  getAuthorizationByOAuthStateMock: vi.fn(),
  approveAuthorizationMock: vi.fn(),
  pollDeviceTokenMock: vi.fn(),
}));
vi.mock('./sso-device-service.js', () => ({
  createSsoDeviceAuthorization: createSsoDeviceAuthorizationMock,
  // Mirrors the real class's fixed, always-identical message (see that
  // class's own comment in sso-device-service.ts) so handleDeviceCode's
  // error_description pass-through can actually be tested here.
  DomainNotRegisteredError: class DomainNotRegisteredError extends Error {
    constructor() {
      super("your organization hasn't enabled RouteShift SSO login");
      this.name = 'DomainNotRegisteredError';
    }
  },
  getAuthorizationByUserCode: getAuthorizationByUserCodeMock,
  bindOAuthState: bindOAuthStateMock,
  denyAuthorization: denyAuthorizationMock,
  getAuthorizationByOAuthState: getAuthorizationByOAuthStateMock,
  approveAuthorization: approveAuthorizationMock,
  pollDeviceToken: pollDeviceTokenMock,
}));

const { resolveIdpConfigByIdMock, validateIssuerViaDiscoveryMock } = vi.hoisted(() => ({
  resolveIdpConfigByIdMock: vi.fn(),
  validateIssuerViaDiscoveryMock: vi.fn(),
}));
vi.mock('./sso-connections.js', () => ({
  resolveIdpConfigById: resolveIdpConfigByIdMock,
  validateIssuerViaDiscovery: validateIssuerViaDiscoveryMock,
}));

const { buildAuthorizationUrlMock, exchangeCodeForIdTokenMock, verifyIdTokenMock } = vi.hoisted(() => ({
  buildAuthorizationUrlMock: vi.fn(() => 'https://idp.example.com/authorize?...'),
  exchangeCodeForIdTokenMock: vi.fn(),
  verifyIdTokenMock: vi.fn(),
}));
vi.mock('./idp-providers.js', () => ({
  buildAuthorizationUrl: buildAuthorizationUrlMock,
  exchangeCodeForIdToken: exchangeCodeForIdTokenMock,
  verifyIdToken: verifyIdTokenMock,
  IdTokenVerificationError: class IdTokenVerificationError extends Error {},
  DomainClaimMismatchError: class DomainClaimMismatchError extends Error {},
}));

const { mintSsoKeyMock } = vi.hoisted(() => ({ mintSsoKeyMock: vi.fn() }));
vi.mock('./sso-key-mint.js', () => ({
  mintSsoKey: mintSsoKeyMock,
  AuthorizationNotConsumableError: class AuthorizationNotConsumableError extends Error {},
}));

vi.mock('../db/pool.js', () => ({ getPool: () => ({}) }));

import { __resetIpRateLimitStore } from '../rate-limit/ip-limiter.js';
import {
  handleDeviceCode,
  handleDeviceVerifyGet,
  handleDeviceVerifyPost,
  handleDeviceCallback,
  handleDeviceToken,
  TOKEN_IP_RATE_LIMIT,
} from './sso-device-handlers.js';

function mockReq(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const bodyStr = body !== undefined ? JSON.stringify(body) : '';
  return {
    method, url,
    headers: { 'content-type': 'application/json', ...headers },
    [Symbol.asyncIterator]: async function* () { if (bodyStr) yield Buffer.from(bodyStr); },
  } as never;
}

function mockRes() {
  const res = {
    statusCode: 0,
    resHeaders: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers?: Record<string, string>) { this.statusCode = code; if (headers) this.resHeaders = headers; },
    end(chunk?: string) { this.body = chunk ?? ''; },
  };
  return res;
}

describe('handleDeviceCode', () => {
  beforeEach(() => {
    __resetIpRateLimitStore();
    createSsoDeviceAuthorizationMock.mockReset();
  });

  it('returns the RFC 8628 response shape on success', async () => {
    createSsoDeviceAuthorizationMock.mockResolvedValue({
      response: {
        device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://api.routeshift.io/oauth/device/verify',
        verification_uri_complete: 'https://api.routeshift.io/oauth/device/verify?user_code=ABCD1234',
        expires_in: 600, interval: 5,
      },
      idpConfig: { teamId: 'team-a' },
    });
    const res = mockRes();

    await handleDeviceCode(mockReq('POST', '/oauth/device/code', { email: 'alice@example.com' }, { 'cf-connecting-ip': '1.2.3.4' }), res as never);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.device_code).toBe('dc');
    expect(parsed.user_code).toBe('ABCD-1234');
  });

  it('maps DomainNotRegisteredError to a generic 400, not a 404 (no enumeration signal)', async () => {
    const { DomainNotRegisteredError } = await import('./sso-device-service.js');
    createSsoDeviceAuthorizationMock.mockRejectedValue(new DomainNotRegisteredError());
    const res = mockRes();

    await handleDeviceCode(mockReq('POST', '/oauth/device/code', { email: 'bob@nowhere.com' }, { 'cf-connecting-ip': '1.2.3.5' }), res as never);

    expect(res.statusCode).toBe(400);
  });

  it('includes DomainNotRegisteredError\'s message as error_description, while error stays invalid_request (fixed, uniform message -- no enumeration signal, but a CLI needs something human-readable to show)', async () => {
    const { DomainNotRegisteredError } = await import('./sso-device-service.js');
    // DomainNotRegisteredError's real constructor takes no arguments -- its
    // message is fixed and uniform by design (see that class's own
    // comment), so there's nothing to parameterize here.
    createSsoDeviceAuthorizationMock.mockRejectedValue(new DomainNotRegisteredError());
    const res = mockRes();

    await handleDeviceCode(mockReq('POST', '/oauth/device/code', { email: 'bob@nowhere.com' }, { 'cf-connecting-ip': '1.2.3.99' }), res as never);

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe('invalid_request');
    expect(parsed.error_description).toBe("your organization hasn't enabled RouteShift SSO login");
  });

  it('rate-limits after the configured threshold for a given IP', async () => {
    createSsoDeviceAuthorizationMock.mockResolvedValue({
      response: { device_code: 'dc', user_code: 'X', verification_uri: 'u', verification_uri_complete: 'u2', expires_in: 600, interval: 5 },
      idpConfig: { teamId: 'team-a' },
    });
    const ip = '9.9.9.9';
    for (let i = 0; i < 10; i++) {
      const res = mockRes();
      await handleDeviceCode(mockReq('POST', '/oauth/device/code', { email: 'x@example.com' }, { 'cf-connecting-ip': ip }), res as never);
    }
    const blocked = mockRes();
    await handleDeviceCode(mockReq('POST', '/oauth/device/code', { email: 'x@example.com' }, { 'cf-connecting-ip': ip }), blocked as never);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.resHeaders['Cache-Control']).toBe('no-store');
  });

  it('rejects a non-JSON Content-Type even with a valid-JSON body (no-JS CSRF bypass guard)', async () => {
    const res = mockRes();

    await handleDeviceCode(
      mockReq('POST', '/oauth/device/code', { email: 'alice@example.com' }, { 'cf-connecting-ip': '5.5.5.1', 'content-type': 'text/plain' }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_request');
    expect(createSsoDeviceAuthorizationMock).not.toHaveBeenCalled();
  });

  it('rejects a missing Content-Type even with a valid-JSON body', async () => {
    const res = mockRes();

    await handleDeviceCode(
      mockReq(
        'POST',
        '/oauth/device/code',
        { email: 'alice@example.com' },
        { 'cf-connecting-ip': '5.5.5.4', 'content-type': undefined as unknown as string },
      ),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_request');
    expect(createSsoDeviceAuthorizationMock).not.toHaveBeenCalled();
  });
});

describe('handleDeviceVerifyGet', () => {
  beforeEach(() => {
    __resetIpRateLimitStore();
    getAuthorizationByUserCodeMock.mockReset();
  });

  it('returns 404 without leaking anything sensitive when the code is not found', async () => {
    getAuthorizationByUserCodeMock.mockResolvedValue(null);
    const res = mockRes();

    await handleDeviceVerifyGet(mockReq('GET', '/oauth/device/verify?user_code=NOPE1234', undefined, { 'cf-connecting-ip': '3.3.3.1' }), res as never);

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('NOPE1234');
    expect(res.body).not.toMatch(/idp|client|secret|token/i);
  });

  it('returns 200 with the user_code rendered in the HTML body when found', async () => {
    getAuthorizationByUserCodeMock.mockResolvedValue({ id: 'auth-1', status: 'pending' });
    const res = mockRes();

    await handleDeviceVerifyGet(mockReq('GET', '/oauth/device/verify?user_code=ABCD1234', undefined, { 'cf-connecting-ip': '3.3.3.2' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ABCD1234');
    expect(res.resHeaders['Cache-Control']).toBe('no-store');
  });

  it('HTML-escapes the user_code before interpolating it into the response (XSS regression)', async () => {
    const payload = `<script>alert("x")</script>&'`;
    getAuthorizationByUserCodeMock.mockResolvedValue({ id: 'auth-1', status: 'pending' });
    const res = mockRes();

    await handleDeviceVerifyGet(
      mockReq('GET', `/oauth/device/verify?user_code=${encodeURIComponent(payload)}`, undefined, { 'cf-connecting-ip': '3.3.3.3' }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    // The <h1> interpolation site HTML-escapes the payload...
    expect(res.body).toContain('&lt;script&gt;');
    expect(res.body).toContain('&amp;');
    expect(res.body).toContain('&#39;');
    // ...and the page's own legitimate inline <script> (added below) also
    // embeds user_code, as a JS string literal for the fetch() body -- so
    // this assertion can no longer be "the page contains no <script> tag at
    // all" (it now legitimately does). What must still hold is that the raw,
    // unescaped payload never appears anywhere in the output verbatim -- in
    // particular, "</script>" inside a naively-embedded JS string literal
    // would prematurely close the real <script> element and inject the rest
    // of the payload as live markup, which this proves didn't happen.
    expect(res.body).not.toContain(payload);
    expect(res.body).not.toContain('<script>alert');
  });

  it('renders Approve/Deny actions as a JS fetch() wired to application/json, not a native form POST (RSH-100 final-review regression)', async () => {
    // The original bug: a real browser submitting a plain <form
    // method="POST" action="/oauth/device/verify"> (no enctype) sends
    // Content-Type: application/x-www-form-urlencoded, which
    // handleDeviceVerifyPost's hasJsonContentType() gate rejects with a 400
    // before user_code/action are ever read -- making the human-approval
    // step of the whole feature non-functional. The fix replaces the native
    // form with client-side JS that fetch()es with an explicit
    // application/json body. This test proves that wiring is actually
    // present in the rendered page.
    getAuthorizationByUserCodeMock.mockResolvedValue({ id: 'auth-1', status: 'pending' });
    const res = mockRes();

    await handleDeviceVerifyGet(mockReq('GET', '/oauth/device/verify?user_code=ABCD1234', undefined, { 'cf-connecting-ip': '3.3.3.4' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('fetch(');
    expect(res.body).toContain("'/oauth/device/verify'");
    expect(res.body).toContain("'Content-Type': 'application/json'");
    expect(res.body).not.toContain('application/x-www-form-urlencoded');
    // No native form-POST left that a real browser could submit on its own.
    expect(res.body).not.toMatch(/<form[^>]*method\s*=\s*["']?post/i);
  });

  it('rate-limits after the configured threshold (30/min) for a given IP', async () => {
    getAuthorizationByUserCodeMock.mockResolvedValue({ id: 'auth-1', status: 'pending' });
    const ip = '3.3.3.9';
    for (let i = 0; i < 30; i++) {
      const res = mockRes();
      await handleDeviceVerifyGet(mockReq('GET', '/oauth/device/verify?user_code=ABCD1234', undefined, { 'cf-connecting-ip': ip }), res as never);
    }
    const blocked = mockRes();
    await handleDeviceVerifyGet(mockReq('GET', '/oauth/device/verify?user_code=ABCD1234', undefined, { 'cf-connecting-ip': ip }), blocked as never);
    expect(blocked.statusCode).toBe(429);
  });
});

describe('handleDeviceVerifyPost (deny)', () => {
  it('marks the row denied and returns a confirmation, not an error', async () => {
    getAuthorizationByUserCodeMock.mockReset();
    denyAuthorizationMock.mockReset();
    getAuthorizationByUserCodeMock.mockResolvedValue({ id: 'auth-1', status: 'pending' });
    denyAuthorizationMock.mockResolvedValue(true);
    const res = mockRes();

    await handleDeviceVerifyPost(mockReq('POST', '/oauth/device/verify', { user_code: 'ABCD1234', action: 'deny' }, { 'cf-connecting-ip': '1.2.3.6' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(denyAuthorizationMock).toHaveBeenCalledWith(expect.anything(), 'auth-1');
  });

  it('returns 404 when the user_code is not found', async () => {
    getAuthorizationByUserCodeMock.mockReset();
    denyAuthorizationMock.mockReset();
    getAuthorizationByUserCodeMock.mockResolvedValue(null);
    const res = mockRes();

    await handleDeviceVerifyPost(mockReq('POST', '/oauth/device/verify', { user_code: 'NOPE1234', action: 'deny' }, { 'cf-connecting-ip': '1.2.3.13' }), res as never);

    expect(res.statusCode).toBe(404);
    expect(denyAuthorizationMock).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON Content-Type even with a valid-JSON approve body (no-JS CSRF bypass guard)', async () => {
    getAuthorizationByUserCodeMock.mockReset();
    denyAuthorizationMock.mockReset();
    const res = mockRes();

    await handleDeviceVerifyPost(
      mockReq(
        'POST',
        '/oauth/device/verify',
        { user_code: 'ABCD1234', action: 'approve' },
        { 'cf-connecting-ip': '5.5.5.2', 'content-type': 'text/plain' },
      ),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_request');
    expect(getAuthorizationByUserCodeMock).not.toHaveBeenCalled();
  });
});

const testIdpConfig = {
  id: 'idp-1', teamId: 'team-a', provider: 'okta' as const, loginDomain: 'example.com',
  issuer: 'https://accounts.example.com', clientId: 'client-1', clientSecret: 'secret-1',
};
const testDiscovery = {
  issuer: 'https://accounts.example.com',
  authorization_endpoint: 'https://accounts.example.com/authorize',
  token_endpoint: 'https://accounts.example.com/token',
  jwks_uri: 'https://accounts.example.com/jwks',
};

describe('handleDeviceVerifyPost (approve)', () => {
  it('binds state/nonce and returns the IdP authorization URL as JSON (not a raw 302)', async () => {
    // Not a raw 302: the only caller of this endpoint is the verify page's
    // own fetch(), and fetch() follows redirects internally/invisibly to the
    // tab -- a 302 here would leave the browser's visible address bar
    // unchanged. Returning { redirect_url } lets the client perform the
    // actual browser navigation itself via window.location.href, which is
    // what makes the IdP's login page visibly show up for the user.
    getAuthorizationByUserCodeMock.mockReset();
    bindOAuthStateMock.mockReset();
    resolveIdpConfigByIdMock.mockReset();
    validateIssuerViaDiscoveryMock.mockReset();
    getAuthorizationByUserCodeMock.mockResolvedValue({ id: 'auth-1', status: 'pending', idp_config_id: 'idp-1' });
    resolveIdpConfigByIdMock.mockResolvedValue(testIdpConfig);
    validateIssuerViaDiscoveryMock.mockResolvedValue(testDiscovery);
    bindOAuthStateMock.mockResolvedValue({ state: 'state-abc', nonce: 'nonce-abc' });
    const res = mockRes();

    await handleDeviceVerifyPost(mockReq('POST', '/oauth/device/verify', { user_code: 'ABCD1234', action: 'approve' }, { 'cf-connecting-ip': '1.2.3.7' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.resHeaders['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(res.body);
    expect(parsed.redirect_url).toBe('https://idp.example.com/authorize?...');
    // The client can reach the IdP's URL straight from this response shape:
    // it's the exact string window.location.href gets set to.
    expect(buildAuthorizationUrlMock).toHaveBeenCalledWith(expect.objectContaining({
      authorizationEndpoint: testDiscovery.authorization_endpoint,
      clientId: testIdpConfig.clientId,
      redirectUri: 'https://api.routeshift.io/oauth/device/callback',
      state: 'state-abc',
      nonce: 'nonce-abc',
    }));
  });

  it('rejects application/x-www-form-urlencoded -- exactly what a real browser submitting the OLD native <form> sent, which broke the approve/deny action end-to-end (RSH-100 final-review Critical bug)', async () => {
    getAuthorizationByUserCodeMock.mockReset();
    bindOAuthStateMock.mockReset();
    const res = mockRes();

    await handleDeviceVerifyPost(
      mockReq('POST', '/oauth/device/verify', undefined, {
        'cf-connecting-ip': '5.5.5.9',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_request');
    expect(getAuthorizationByUserCodeMock).not.toHaveBeenCalled();
  });

  it('returns 400 (not a redirect) when bindOAuthState returns null because the row is no longer pending', async () => {
    getAuthorizationByUserCodeMock.mockReset();
    bindOAuthStateMock.mockReset();
    resolveIdpConfigByIdMock.mockReset();
    validateIssuerViaDiscoveryMock.mockReset();
    buildAuthorizationUrlMock.mockClear();
    getAuthorizationByUserCodeMock.mockResolvedValue({ id: 'auth-1', status: 'pending', idp_config_id: 'idp-1' });
    resolveIdpConfigByIdMock.mockResolvedValue(testIdpConfig);
    validateIssuerViaDiscoveryMock.mockResolvedValue(testDiscovery);
    bindOAuthStateMock.mockResolvedValue(null);
    const res = mockRes();

    await handleDeviceVerifyPost(mockReq('POST', '/oauth/device/verify', { user_code: 'ABCD1234', action: 'approve' }, { 'cf-connecting-ip': '1.2.3.11' }), res as never);

    expect(res.statusCode).toBe(400);
    expect(buildAuthorizationUrlMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the IdP config can no longer be resolved (e.g. removed/suspended)', async () => {
    getAuthorizationByUserCodeMock.mockReset();
    bindOAuthStateMock.mockReset();
    resolveIdpConfigByIdMock.mockReset();
    validateIssuerViaDiscoveryMock.mockReset();
    buildAuthorizationUrlMock.mockClear();
    getAuthorizationByUserCodeMock.mockResolvedValue({ id: 'auth-1', status: 'pending', idp_config_id: 'idp-1' });
    resolveIdpConfigByIdMock.mockResolvedValue(null);
    const res = mockRes();

    await handleDeviceVerifyPost(mockReq('POST', '/oauth/device/verify', { user_code: 'ABCD1234', action: 'approve' }, { 'cf-connecting-ip': '1.2.3.14' }), res as never);

    expect(res.statusCode).toBe(400);
    expect(validateIssuerViaDiscoveryMock).not.toHaveBeenCalled();
    expect(buildAuthorizationUrlMock).not.toHaveBeenCalled();
  });
});

describe('handleDeviceCallback', () => {
  beforeEach(() => {
    __resetIpRateLimitStore();
    resolveIdpConfigByIdMock.mockReset();
    validateIssuerViaDiscoveryMock.mockReset();
    resolveIdpConfigByIdMock.mockResolvedValue(testIdpConfig);
    validateIssuerViaDiscoveryMock.mockResolvedValue(testDiscovery);
  });

  it('exchanges the code, verifies the ID token, approves the row', async () => {
    getAuthorizationByOAuthStateMock.mockReset();
    exchangeCodeForIdTokenMock.mockReset();
    verifyIdTokenMock.mockReset();
    approveAuthorizationMock.mockReset();
    getAuthorizationByOAuthStateMock.mockResolvedValue({ id: 'auth-1', idp_config_id: 'idp-1', oidc_nonce: 'nonce-abc' });
    exchangeCodeForIdTokenMock.mockResolvedValue('id-token-raw');
    verifyIdTokenMock.mockResolvedValue({ email: 'alice@example.com', sub: 'sub-1' });
    approveAuthorizationMock.mockResolvedValue(true);
    const res = mockRes();

    await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?code=auth-code&state=state-abc', undefined, { 'cf-connecting-ip': '1.2.3.8' }), res as never);

    expect(exchangeCodeForIdTokenMock).toHaveBeenCalledWith(expect.objectContaining({
      tokenEndpoint: testDiscovery.token_endpoint, clientId: testIdpConfig.clientId, clientSecret: testIdpConfig.clientSecret,
      redirectUri: 'https://api.routeshift.io/oauth/device/callback',
    }));
    expect(verifyIdTokenMock).toHaveBeenCalledWith(expect.objectContaining({
      jwksUri: testDiscovery.jwks_uri, expectedLoginDomain: testIdpConfig.loginDomain, expectedNonce: 'nonce-abc',
    }));
    expect(approveAuthorizationMock).toHaveBeenCalledWith(expect.anything(), 'auth-1', 'alice@example.com');
    expect(res.statusCode).toBe(200);
  });

  it('shows a "no longer valid" message (not "Approved") when approveAuthorization TOCTOU-loses to a concurrent expiry/deny -- the browser must not claim success for nothing', async () => {
    getAuthorizationByOAuthStateMock.mockReset();
    exchangeCodeForIdTokenMock.mockReset();
    verifyIdTokenMock.mockReset();
    approveAuthorizationMock.mockReset();
    getAuthorizationByOAuthStateMock.mockResolvedValue({ id: 'auth-1', idp_config_id: 'idp-1', oidc_nonce: 'nonce-abc' });
    exchangeCodeForIdTokenMock.mockResolvedValue('id-token-raw');
    verifyIdTokenMock.mockResolvedValue({ email: 'alice@example.com', sub: 'sub-1' });
    approveAuthorizationMock.mockResolvedValue(false);
    const res = mockRes();

    await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?code=auth-code&state=state-abc', undefined, { 'cf-connecting-ip': '1.2.3.20' }), res as never);

    // Still a 200 from the browser's perspective -- this isn't an error
    // condition, just different informational content than the success case.
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('Approved. You can close this window');
    expect(res.body).toMatch(/no longer valid/i);
  });

  it('fails closed on a domain-claim mismatch without approving the row', async () => {
    const { DomainClaimMismatchError } = await import('./idp-providers.js');
    getAuthorizationByOAuthStateMock.mockReset();
    verifyIdTokenMock.mockReset();
    approveAuthorizationMock.mockReset();
    getAuthorizationByOAuthStateMock.mockResolvedValue({ id: 'auth-1', idp_config_id: 'idp-1', oidc_nonce: 'nonce-abc' });
    exchangeCodeForIdTokenMock.mockResolvedValue('id-token-raw');
    verifyIdTokenMock.mockRejectedValue(new DomainClaimMismatchError('evil.com', 'example.com'));
    const res = mockRes();

    await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?code=auth-code&state=state-abc', undefined, { 'cf-connecting-ip': '1.2.3.9' }), res as never);

    expect(approveAuthorizationMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('fails closed on ID token verification failure without approving the row', async () => {
    const { IdTokenVerificationError } = await import('./idp-providers.js');
    getAuthorizationByOAuthStateMock.mockReset();
    verifyIdTokenMock.mockReset();
    approveAuthorizationMock.mockReset();
    getAuthorizationByOAuthStateMock.mockResolvedValue({ id: 'auth-1', idp_config_id: 'idp-1', oidc_nonce: 'nonce-abc' });
    exchangeCodeForIdTokenMock.mockResolvedValue('id-token-raw');
    verifyIdTokenMock.mockRejectedValue(new IdTokenVerificationError('signature mismatch'));
    const res = mockRes();

    await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?code=auth-code&state=state-abc', undefined, { 'cf-connecting-ip': '1.2.3.12' }), res as never);

    expect(approveAuthorizationMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('returns 400 for an unknown/expired state instead of a 500', async () => {
    getAuthorizationByOAuthStateMock.mockReset();
    getAuthorizationByOAuthStateMock.mockResolvedValue(null);
    const res = mockRes();

    await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?code=auth-code&state=unknown-state', undefined, { 'cf-connecting-ip': '1.2.3.10' }), res as never);

    expect(res.statusCode).toBe(400);
  });

  // Codex review finding: unlike its 4 sibling device-flow endpoints (all of
  // which start with a rateLimited(...) check), handleDeviceCallback was
  // completely unthrottled -- a flood of forged/replayed `state` values
  // could drive unbounded DB lookups and, for a valid state, real outbound
  // discovery/token-exchange traffic to the IdP. This proves the fix: IP-keyed,
  // same convention as handleDeviceCode/handleDeviceVerifyGet/Post.
  it('rate-limits after the configured threshold (60/min) for a given IP', async () => {
    getAuthorizationByOAuthStateMock.mockReset();
    // A DB-miss (state not found) is enough to prove the rate limit trips --
    // it's checked before any of the expensive downstream work runs.
    getAuthorizationByOAuthStateMock.mockResolvedValue(null);
    const ip = '1.2.3.200';
    for (let i = 0; i < 60; i++) {
      const res = mockRes();
      await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?code=abc&state=xyz', undefined, { 'cf-connecting-ip': ip }), res as never);
    }
    const blocked = mockRes();
    await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?code=abc&state=xyz', undefined, { 'cf-connecting-ip': ip }), blocked as never);
    expect(blocked.statusCode).toBe(429);
    // The DB was never even queried for this request -- it was rejected
    // before handleDeviceCallback's body ran.
    expect(getAuthorizationByOAuthStateMock).toHaveBeenCalledTimes(60);
  });
});

describe('handleDeviceToken', () => {
  beforeEach(() => {
    __resetIpRateLimitStore();
    pollDeviceTokenMock.mockReset();
    mintSsoKeyMock.mockReset();
  });

  it('mints and returns an OAuth-shaped response on ready_to_mint', async () => {
    pollDeviceTokenMock.mockResolvedValue({
      status: 'ready_to_mint',
      row: { id: 'auth-1', team_id: 'team-a', verified_email: 'alice@example.com' },
    });
    mintSsoKeyMock.mockResolvedValue({ id: 'key-1', key: 'sk-proxy-live_team_x', prefix: 'sk-proxy-live_team', expiresAt: new Date(Date.now() + 28800_000) });
    const res = mockRes();

    await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: 'dc-raw' }, { 'cf-connecting-ip': '2.2.2.2' }), res as never);

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.access_token).toBe('sk-proxy-live_team_x');
    expect(parsed.token_type).toBe('bearer');
    expect(parsed.key_prefix).toBe('sk-proxy-live_team');
    expect(res.resHeaders['Cache-Control']).toBe('no-store');
  });

  it('maps each non-ready poll status to its RFC 8628 error code', async () => {
    const cases: Array<[string, number]> = [
      ['authorization_pending', 400], ['slow_down', 400], ['expired_token', 400],
      ['access_denied', 400], ['invalid_grant', 400],
    ];
    for (const [status] of cases) {
      pollDeviceTokenMock.mockResolvedValue({ status });
      const res = mockRes();
      await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: 'dc-raw' }, { 'cf-connecting-ip': '2.2.2.3' }), res as never);
      const parsed = JSON.parse(res.body);
      expect(parsed.error).toBe(status);
    }
  });

  it('maps AuthorizationNotConsumableError from mintSsoKey to invalid_grant, not a 500', async () => {
    const { AuthorizationNotConsumableError } = await import('./sso-key-mint.js');
    pollDeviceTokenMock.mockResolvedValue({
      status: 'ready_to_mint',
      row: { id: 'auth-1', team_id: 'team-a', verified_email: 'alice@example.com' },
    });
    mintSsoKeyMock.mockRejectedValue(new AuthorizationNotConsumableError('auth-1', 'consumed'));
    const res = mockRes();

    await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: 'dc-raw' }, { 'cf-connecting-ip': '2.2.2.4' }), res as never);

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe('invalid_grant');
  });

  it('rejects a non-JSON Content-Type even with a valid-JSON body (no-JS CSRF bypass guard)', async () => {
    const res = mockRes();

    await handleDeviceToken(
      mockReq('POST', '/oauth/device/token', { device_code: 'dc-raw' }, { 'cf-connecting-ip': '5.5.5.3', 'content-type': 'text/plain' }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_request');
    expect(pollDeviceTokenMock).not.toHaveBeenCalled();
  });

  it('rate-limits by device_code, not by source IP: two different IPs sharing the SAME device_code both hit one shared budget', async () => {
    pollDeviceTokenMock.mockResolvedValue({ status: 'authorization_pending' });
    const deviceCode = 'shared-device-code-across-ips';
    // 60 polls for the same device_code, alternating between two different
    // source IPs -- if this were still IP-keyed (the bug), each IP would
    // have its own 60/min budget and neither would ever see a 429 here.
    for (let i = 0; i < 60; i++) {
      const res = mockRes();
      const ip = i % 2 === 0 ? '10.0.0.1' : '10.0.0.2';
      await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: deviceCode }, { 'cf-connecting-ip': ip }), res as never);
    }
    const blocked = mockRes();
    await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: deviceCode }, { 'cf-connecting-ip': '10.0.0.3' }), blocked as never);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.resHeaders['Cache-Control']).toBe('no-store');
  });

  it('does not rate-limit two different device_codes against each other, even from the same source IP (the false-positive this fix avoids: a shared corporate NAT/IP with many employees polling different device_codes)', async () => {
    pollDeviceTokenMock.mockResolvedValue({ status: 'authorization_pending' });
    const ip = '10.0.0.9';
    for (let i = 0; i < 60; i++) {
      const res = mockRes();
      await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: 'device-code-A' }, { 'cf-connecting-ip': ip }), res as never);
    }
    // device-code-A is now at its own limit from this IP, but a DIFFERENT
    // device_code from the exact same IP must be unaffected.
    const resB = mockRes();
    await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: 'device-code-B' }, { 'cf-connecting-ip': ip }), resB as never);
    expect(resB.statusCode).not.toBe(429);
  });

  it('a missing device_code always returns 400, never 429 -- no rate-limit key can be computed and no check is consulted before the 400', async () => {
    const ip = '10.0.0.21';
    for (let i = 0; i < 100; i++) {
      const res = mockRes();
      await handleDeviceToken(mockReq('POST', '/oauth/device/token', {}, { 'cf-connecting-ip': ip }), res as never);
      expect(res.statusCode).toBe(400);
    }
    expect(pollDeviceTokenMock).not.toHaveBeenCalled();
  });
});

describe('handleDeviceToken — per-IP ceiling (RSH-100 review fix: DoS via fresh device_codes)', () => {
  beforeEach(() => {
    __resetIpRateLimitStore();
    pollDeviceTokenMock.mockReset();
  });

  it('429s a single IP that floods /token with DISTINCT device_codes (which never trip the device_code-keyed limiter)', async () => {
    pollDeviceTokenMock.mockResolvedValue({ status: 'authorization_pending' });
    const ip = '203.0.113.7';
    // Every request carries a fresh device_code, so deviceTokenRateLimited
    // (keyed by the code hash) never fires -- only the new per-IP ceiling can
    // stop this. All requests up to the ceiling must be allowed through.
    for (let i = 0; i < TOKEN_IP_RATE_LIMIT; i++) {
      const res = mockRes();
      await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: `flood-${i}` }, { 'cf-connecting-ip': ip }), res as never);
      expect(res.statusCode).not.toBe(429);
    }
    const blocked = mockRes();
    await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: 'flood-final' }, { 'cf-connecting-ip': ip }), blocked as never);
    expect(blocked.statusCode).toBe(429);
  });

  it('does not let one flooding IP throttle a different IP (per-IP isolation)', async () => {
    pollDeviceTokenMock.mockResolvedValue({ status: 'authorization_pending' });
    for (let i = 0; i < TOKEN_IP_RATE_LIMIT; i++) {
      const res = mockRes();
      await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: `f-${i}` }, { 'cf-connecting-ip': '203.0.113.8' }), res as never);
    }
    const other = mockRes();
    await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: 'ok' }, { 'cf-connecting-ip': '203.0.113.9' }), other as never);
    expect(other.statusCode).not.toBe(429);
  });
});

describe('readJsonBody size cap (RSH-100 review fix: unauthenticated OOM defense)', () => {
  beforeEach(() => {
    __resetIpRateLimitStore();
    pollDeviceTokenMock.mockReset();
    pollDeviceTokenMock.mockResolvedValue({ status: 'authorization_pending' });
  });

  it('rejects an over-cap request body with 400 instead of buffering it, and never reaches the DB', async () => {
    // ~70KB serialized body, over the 64KB cap.
    const huge = { device_code: 'x'.repeat(70_000) };
    const res = mockRes();
    await handleDeviceToken(mockReq('POST', '/oauth/device/token', huge, { 'cf-connecting-ip': '198.51.100.5' }), res as never);
    expect(res.statusCode).toBe(400);
    expect(pollDeviceTokenMock).not.toHaveBeenCalled();
  });

  it('accepts a normal-sized body (regression guard that the cap is not too tight)', async () => {
    pollDeviceTokenMock.mockResolvedValue({ status: 'authorization_pending' });
    const res = mockRes();
    await handleDeviceToken(mockReq('POST', '/oauth/device/token', { device_code: 'x'.repeat(2_000) }, { 'cf-connecting-ip': '198.51.100.6' }), res as never);
    expect(pollDeviceTokenMock).toHaveBeenCalled();
  });
});

describe('handleDeviceCallback — IdP error redirect (RSH-100 review fix: RFC 6749 §4.1.2.1)', () => {
  beforeEach(() => {
    __resetIpRateLimitStore();
    getAuthorizationByOAuthStateMock.mockReset();
    denyAuthorizationMock.mockReset();
    exchangeCodeForIdTokenMock.mockReset();
  });

  it('marks the row denied and shows a message when the IdP redirects ?error=access_denied (not a raw 400 leaving the row pending)', async () => {
    getAuthorizationByOAuthStateMock.mockResolvedValue({ id: 'auth-1', idp_config_id: 'idp-1' });
    denyAuthorizationMock.mockResolvedValue(true);
    const res = mockRes();
    await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?error=access_denied&state=st-1'), res as never);
    expect(denyAuthorizationMock).toHaveBeenCalledWith(expect.anything(), 'auth-1');
    expect(res.statusCode).toBe(200);
    expect(res.body.toLowerCase()).toContain('denied');
  });

  it('does not attempt a token exchange when the IdP returned an error', async () => {
    getAuthorizationByOAuthStateMock.mockResolvedValue({ id: 'auth-2', idp_config_id: 'idp-1' });
    denyAuthorizationMock.mockResolvedValue(true);
    const res = mockRes();
    await handleDeviceCallback(mockReq('GET', '/oauth/device/callback?error=access_denied&error_description=user+said+no&state=st-2'), res as never);
    expect(exchangeCodeForIdTokenMock).not.toHaveBeenCalled();
  });
});
