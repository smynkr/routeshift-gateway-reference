import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { requireAdminAuth } from '../src/admin/auth.js';

function makeReq(authHeader?: string): IncomingMessage {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as IncomingMessage;
}

function makeRes() {
  let statusCode = 0;
  let body = '';
  const headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, nextHeaders: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, nextHeaders);
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get headers() {
      return headers;
    },
  };
}

describe('requireAdminAuth', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fails closed in development when ADMIN_SECRET is not set', () => {
    delete process.env.ADMIN_SECRET;
    delete process.env.ALLOW_UNAUTHENTICATED_ADMIN_DEV;
    process.env.NODE_ENV = 'development';

    const out = makeRes();
    const ok = requireAdminAuth(makeReq(), out.res);

    expect(ok).toBe(false);
    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'ADMIN_SECRET is not configured' } });
  });

  it('allows explicit unauthenticated development mode only on localhost-bound requests', () => {
    delete process.env.ADMIN_SECRET;
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_UNAUTHENTICATED_ADMIN_DEV = 'true';

    const out = makeRes();
    const req = makeReq();
    req.socket = {
      localAddress: '127.0.0.1',
      remoteAddress: '127.0.0.1',
    } as IncomingMessage['socket'];

    const ok = requireAdminAuth(req, out.res);

    expect(ok).toBe(true);
    expect(out.statusCode).toBe(0);
  });

  it('rejects explicit unauthenticated development mode when the client is not local', () => {
    delete process.env.ADMIN_SECRET;
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_UNAUTHENTICATED_ADMIN_DEV = 'true';

    const out = makeRes();
    const req = makeReq();
    req.socket = {
      localAddress: '127.0.0.1',
      remoteAddress: '10.0.0.12',
    } as IncomingMessage['socket'];

    const ok = requireAdminAuth(req, out.res);

    expect(ok).toBe(false);
    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'ADMIN_SECRET is not configured' } });
  });

  it('rejects explicit unauthenticated development mode on non-local requests', () => {
    delete process.env.ADMIN_SECRET;
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_UNAUTHENTICATED_ADMIN_DEV = 'true';

    const out = makeRes();
    const req = makeReq();
    req.socket = { localAddress: '10.0.0.12' } as IncomingMessage['socket'];

    const ok = requireAdminAuth(req, out.res);

    expect(ok).toBe(false);
    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'ADMIN_SECRET is not configured' } });
  });

  it('returns 500 in production when ADMIN_SECRET is missing', () => {
    delete process.env.ADMIN_SECRET;
    process.env.ALLOW_UNAUTHENTICATED_ADMIN_DEV = 'true';
    process.env.NODE_ENV = 'production';

    const out = makeRes();
    const ok = requireAdminAuth(makeReq(), out.res);

    expect(ok).toBe(false);
    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'ADMIN_SECRET is not configured' } });
  });

  it('returns 401 when token is missing or invalid', () => {
    process.env.ADMIN_SECRET = 'super-secret-admin-token';
    process.env.NODE_ENV = 'production';

    const missing = makeRes();
    const invalid = makeRes();

    expect(requireAdminAuth(makeReq(), missing.res)).toBe(false);
    expect(requireAdminAuth(makeReq('Bearer wrong'), invalid.res)).toBe(false);

    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
  });

  it('returns true for a valid bearer token', () => {
    process.env.ADMIN_SECRET = 'super-secret-admin-token';
    process.env.NODE_ENV = 'production';

    const out = makeRes();
    const ok = requireAdminAuth(makeReq('Bearer super-secret-admin-token'), out.res);

    expect(ok).toBe(true);
    expect(out.statusCode).toBe(0);
  });

  it('rejects secrets shorter than 16 characters', () => {
    process.env.ADMIN_SECRET = 'short';
    process.env.NODE_ENV = 'production';

    const out = makeRes();
    const ok = requireAdminAuth(makeReq('Bearer short'), out.res);

    expect(ok).toBe(false);
    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'ADMIN_SECRET must be at least 16 characters' } });
  });
});
