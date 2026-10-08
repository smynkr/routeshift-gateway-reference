// apps/proxy/src/server-sso-routes.test.ts
// RSH-100 Task 14: a thin routing smoke test -- confirms each of the 8 new
// paths/methods reaches its intended handler (mocked) rather than falling
// through to the 404 catch-all, and that the 3 admin idp-configs routes
// actually invoke requireAdminAuth (proving the guard is wired, not
// bypassed). This is NOT a re-test of handler internals -- those are
// already covered in oauth/sso-device-handlers.test.ts and
// admin/idp-configs.test.ts.
//
// Follows the real-server-plus-real-HTTP-round-trip convention already
// established by catalog/handlers.test.ts (createProxyServer(0) + a raw
// node:http request), rather than reaching for mockReq/mockRes -- that
// style exercises server.ts's actual request dispatcher, which is the
// thing this task changed.
import { request } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: see admin/idp-configs.test.ts's comment -- factories run
// before this file's own top-level code, so mock.fn()s referenced inside a
// vi.mock() factory must come from vi.hoisted(), not a plain top-level const.
// server.ts calls `.catch()` on every handler's return value (they're all
// `async function`s in production), so these mocks must return a Promise
// too -- a plain sync fn returning undefined blows up `.catch()` at the
// route call site with "Cannot read properties of undefined (reading
// 'catch')" (confirmed empirically).
const mocks = vi.hoisted(() => ({
  handleDeviceCode: vi.fn(async (_req: unknown, res: any) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handler: 'device-code' }));
  }),
  handleDeviceVerifyGet: vi.fn(async (_req: unknown, res: any) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>device-verify-get</html>');
  }),
  handleDeviceVerifyPost: vi.fn(async (_req: unknown, res: any) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handler: 'device-verify-post' }));
  }),
  handleDeviceCallback: vi.fn(async (_req: unknown, res: any) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>device-callback</html>');
  }),
  handleDeviceToken: vi.fn(async (_req: unknown, res: any) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handler: 'device-token' }));
  }),
  handleCreateIdpConfig: vi.fn(async (_req: unknown, res: any) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handler: 'idp-configs-create' }));
  }),
  handleUpdateIdpConfig: vi.fn(async (_req: unknown, res: any, _id: string) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handler: 'idp-configs-update' }));
  }),
  handleDeleteIdpConfig: vi.fn(async (_req: unknown, res: any, _id: string) => {
    res.writeHead(204);
    res.end();
  }),
  requireAdminAuth: vi.fn((_req: unknown, _res: unknown) => true),
}));

// Fix 1 (codex review): config.ts's `export const config = loadConfig()` is a
// module-load-time singleton, so CORS_ORIGIN must be set before ./server.js
// (which transitively imports config.js) is ever imported below. vi.hoisted
// callbacks run before every vi.mock/import in this file, same as the mocks
// object above -- a plain top-level `process.env.CORS_ORIGIN = ...` statement
// here would NOT work, since import statements are evaluated before other
// top-level statements regardless of source position. Deliberately an
// explicit, non-wildcard allowlist that does NOT include the disallowed
// origin used below, and does not include '*' -- this is what an admin would
// realistically configure to let the dashboard call the proxy's admin API,
// predating RSH-100 and never intended to cover the proxy calling itself.
vi.hoisted(() => {
  process.env.CORS_ORIGIN = 'https://dashboard.routeshift.io';
});

vi.mock('./oauth/sso-device-handlers.js', () => ({
  handleDeviceCode: mocks.handleDeviceCode,
  handleDeviceVerifyGet: mocks.handleDeviceVerifyGet,
  handleDeviceVerifyPost: mocks.handleDeviceVerifyPost,
  handleDeviceCallback: mocks.handleDeviceCallback,
  handleDeviceToken: mocks.handleDeviceToken,
}));
vi.mock('./admin/idp-configs.js', () => ({
  handleCreateIdpConfig: mocks.handleCreateIdpConfig,
  handleUpdateIdpConfig: mocks.handleUpdateIdpConfig,
  handleDeleteIdpConfig: mocks.handleDeleteIdpConfig,
}));
vi.mock('./admin/auth.js', () => ({
  requireAdminAuth: mocks.requireAdminAuth,
}));

import { createProxyServer } from './server.js';

function httpRequest(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpRequestWithHeaders(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('RSH-100 route registration', () => {
  let app: ReturnType<typeof createProxyServer>;
  let port: number;

  beforeAll(async () => {
    app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
    port = address.port;
  });

  afterAll(async () => {
    await app.stop();
  });

  beforeEach(() => {
    // clearAllMocks resets call counts/results but preserves the
    // implementations set above via vi.fn(impl) -- vi.resetAllMocks() would
    // also strip those default implementations, which we don't want here.
    vi.clearAllMocks();
    mocks.requireAdminAuth.mockImplementation(() => true);
  });

  describe('device-flow routes (public, unauthenticated)', () => {
    it('POST /oauth/device/code reaches handleDeviceCode', async () => {
      const res = await httpRequest(port, 'POST', '/oauth/device/code');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ handler: 'device-code' });
      expect(mocks.handleDeviceCode).toHaveBeenCalledTimes(1);
      expect(mocks.handleDeviceVerifyGet).not.toHaveBeenCalled();
      expect(mocks.handleDeviceVerifyPost).not.toHaveBeenCalled();
      expect(mocks.handleDeviceCallback).not.toHaveBeenCalled();
      expect(mocks.handleDeviceToken).not.toHaveBeenCalled();
    });

    it('GET /oauth/device/verify reaches handleDeviceVerifyGet', async () => {
      const res = await httpRequest(port, 'GET', '/oauth/device/verify?user_code=ABCD-EFGH');
      expect(res.status).toBe(200);
      expect(res.body).toContain('device-verify-get');
      expect(mocks.handleDeviceVerifyGet).toHaveBeenCalledTimes(1);
      expect(mocks.handleDeviceCode).not.toHaveBeenCalled();
      expect(mocks.handleDeviceVerifyPost).not.toHaveBeenCalled();
    });

    it('POST /oauth/device/verify reaches handleDeviceVerifyPost', async () => {
      const res = await httpRequest(port, 'POST', '/oauth/device/verify');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ handler: 'device-verify-post' });
      expect(mocks.handleDeviceVerifyPost).toHaveBeenCalledTimes(1);
      expect(mocks.handleDeviceVerifyGet).not.toHaveBeenCalled();
    });

    it('GET /oauth/device/callback reaches handleDeviceCallback', async () => {
      const res = await httpRequest(port, 'GET', '/oauth/device/callback?code=abc&state=xyz');
      expect(res.status).toBe(200);
      expect(res.body).toContain('device-callback');
      expect(mocks.handleDeviceCallback).toHaveBeenCalledTimes(1);
      expect(mocks.handleDeviceVerifyGet).not.toHaveBeenCalled();
    });

    it('POST /oauth/device/token reaches handleDeviceToken', async () => {
      const res = await httpRequest(port, 'POST', '/oauth/device/token');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ handler: 'device-token' });
      expect(mocks.handleDeviceToken).toHaveBeenCalledTimes(1);
      expect(mocks.handleDeviceCode).not.toHaveBeenCalled();
    });

    it('does not require admin auth for any device-flow route', async () => {
      await httpRequest(port, 'POST', '/oauth/device/code');
      await httpRequest(port, 'GET', '/oauth/device/verify');
      await httpRequest(port, 'POST', '/oauth/device/verify');
      await httpRequest(port, 'GET', '/oauth/device/callback');
      await httpRequest(port, 'POST', '/oauth/device/token');
      expect(mocks.requireAdminAuth).not.toHaveBeenCalled();
    });
  });

  describe('admin idp-configs routes (requireAdminAuth-gated)', () => {
    it('POST /admin/idp-configs calls requireAdminAuth then reaches handleCreateIdpConfig', async () => {
      const res = await httpRequest(port, 'POST', '/admin/idp-configs');
      expect(res.status).toBe(201);
      expect(JSON.parse(res.body)).toEqual({ handler: 'idp-configs-create' });
      expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
      expect(mocks.handleCreateIdpConfig).toHaveBeenCalledTimes(1);
    });

    it('PATCH /admin/idp-configs/:id calls requireAdminAuth then reaches handleUpdateIdpConfig with the id segment', async () => {
      const res = await httpRequest(port, 'PATCH', '/admin/idp-configs/conn-1?team_id=team-a');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ handler: 'idp-configs-update' });
      expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
      expect(mocks.handleUpdateIdpConfig).toHaveBeenCalledTimes(1);
      expect(mocks.handleUpdateIdpConfig.mock.calls[0][2]).toBe('conn-1');
    });

    it('DELETE /admin/idp-configs/:id calls requireAdminAuth then reaches handleDeleteIdpConfig with the id segment', async () => {
      const res = await httpRequest(port, 'DELETE', '/admin/idp-configs/conn-1?team_id=team-a');
      expect(res.status).toBe(204);
      expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
      expect(mocks.handleDeleteIdpConfig).toHaveBeenCalledTimes(1);
      expect(mocks.handleDeleteIdpConfig.mock.calls[0][2]).toBe('conn-1');
    });

    // Proves the guard is a real gate, not dead code whose return value is
    // ignored: when requireAdminAuth denies, the underlying handler must
    // never run.
    it('blocks the handler when requireAdminAuth denies the request', async () => {
      mocks.requireAdminAuth.mockImplementationOnce((_req: unknown, res: any) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
        return false;
      });

      const res = await httpRequest(port, 'POST', '/admin/idp-configs');

      expect(res.status).toBe(401);
      expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
      expect(mocks.handleCreateIdpConfig).not.toHaveBeenCalled();
    });

    it('PATCH without an id segment falls through to 404 (does not silently match)', async () => {
      const res = await httpRequest(port, 'PATCH', '/admin/idp-configs/');
      expect(res.status).toBe(404);
      expect(mocks.handleUpdateIdpConfig).not.toHaveBeenCalled();
    });
  });

  // Fix 1 (codex review): the verify page's own inline JS does a same-origin
  // fetch() POST to /oauth/device/verify. Browsers attach an Origin header to
  // same-origin state-changing fetch()es too, not just cross-origin ones. If
  // CORS_ORIGIN (configured for the dashboard's origin calling the proxy's
  // admin API, predating RSH-100) doesn't happen to include the proxy's own
  // origin, applyCors would 403 that same-origin fetch() before
  // handleDeviceVerifyPost ever runs -- silently breaking the entire
  // Approve/Deny flow. The 5 /oauth/device/* routes must bypass the
  // origin-allowlist rejection entirely, while every other route must keep
  // enforcing it exactly as before.
  describe('CORS: /oauth/device/* is exempt from the origin allowlist', () => {
    const disallowedOrigin = 'https://not-on-the-allowlist.example.com';

    it('GET /oauth/device/verify with a disallowed Origin still reaches its handler (not blocked with 403)', async () => {
      const res = await httpRequestWithHeaders(port, 'GET', '/oauth/device/verify?user_code=ABCD-EFGH', {
        Origin: disallowedOrigin,
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('device-verify-get');
      expect(mocks.handleDeviceVerifyGet).toHaveBeenCalledTimes(1);
    });

    it('POST /oauth/device/verify with a disallowed Origin still reaches its handler (the actual Approve/Deny bug)', async () => {
      const res = await httpRequestWithHeaders(port, 'POST', '/oauth/device/verify', {
        Origin: disallowedOrigin,
        'Content-Type': 'application/json',
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ handler: 'device-verify-post' });
      expect(mocks.handleDeviceVerifyPost).toHaveBeenCalledTimes(1);
    });

    it('POST /oauth/device/code with a disallowed Origin still reaches its handler', async () => {
      const res = await httpRequestWithHeaders(port, 'POST', '/oauth/device/code', { Origin: disallowedOrigin });
      expect(res.status).toBe(200);
      expect(mocks.handleDeviceCode).toHaveBeenCalledTimes(1);
    });

    it('GET /oauth/device/callback with a disallowed Origin still reaches its handler', async () => {
      const res = await httpRequestWithHeaders(port, 'GET', '/oauth/device/callback?code=abc&state=xyz', {
        Origin: disallowedOrigin,
      });
      expect(res.status).toBe(200);
      expect(mocks.handleDeviceCallback).toHaveBeenCalledTimes(1);
    });

    it('POST /oauth/device/token with a disallowed Origin still reaches its handler', async () => {
      const res = await httpRequestWithHeaders(port, 'POST', '/oauth/device/token', { Origin: disallowedOrigin });
      expect(res.status).toBe(200);
      expect(mocks.handleDeviceToken).toHaveBeenCalledTimes(1);
    });

    // Uses /admin/idp-configs (not /oauth/device/*) as the "some other
    // route" control -- it's mocked in this file (unlike /admin/keys, which
    // would hit a real, unmocked DB-backed handler here), and it is not
    // under the /oauth/device/* prefix, which is exactly the property this
    // test needs: proving the origin-allowlist rejection still applies to
    // every route outside that prefix, i.e. this fix did not disable CORS
    // enforcement globally.
    it('a non-SSO-device route (POST /admin/idp-configs) with a disallowed Origin is still correctly rejected with 403', async () => {
      const res = await httpRequestWithHeaders(port, 'POST', '/admin/idp-configs', { Origin: disallowedOrigin });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: { message: 'CORS origin is not allowed' } });
      // Blocked before routing even reaches the admin-auth gate or the handler.
      expect(mocks.requireAdminAuth).not.toHaveBeenCalled();
      expect(mocks.handleCreateIdpConfig).not.toHaveBeenCalled();
    });

    it('an allowed Origin on that same non-SSO-device route still works as before (CORS allowlist itself is unchanged)', async () => {
      const res = await httpRequestWithHeaders(port, 'POST', '/admin/idp-configs', {
        Origin: 'https://dashboard.routeshift.io',
      });
      expect(res.status).toBe(201);
      expect(mocks.requireAdminAuth).toHaveBeenCalledTimes(1);
      expect(mocks.handleCreateIdpConfig).toHaveBeenCalledTimes(1);
    });
  });
});
