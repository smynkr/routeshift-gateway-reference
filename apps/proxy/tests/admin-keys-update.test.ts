import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  invalidateKeyCache: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({
    query: mocks.query,
    // RSH-146: the update handler runs in a transaction (client.query);
    // delegate to the same spy so existing call-sequence assertions hold.
        connect: async () => ({
      // BEGIN/COMMIT/ROLLBACK never touch the assertion spy, so existing
      // mockResolvedValueOnce sequences keep targeting real statements.
      query: async (sql: unknown, params?: unknown[]) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(String(sql))) return { rows: [] };
        return mocks.query(sql, params);
      },
      release: () => {},
    }),
  }),
}));

vi.mock('../src/auth/api-key.js', () => ({
  invalidateKeyCache: mocks.invalidateKeyCache,
  generateApiKey: vi.fn(),
}));

vi.mock('../src/billing/plan-limits.js', () => ({
  checkLimit: vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 100 }),
}));

import { handleUpdateKey } from '../src/admin/keys.js';

function makeReq(options: { url: string; body?: string }): IncomingMessage {
  const stream = Readable.from(options.body !== undefined ? [Buffer.from(options.body)] : []);
  return Object.assign(stream, {
    url: options.url,
    headers: { host: 'localhost' },
  }) as IncomingMessage;
}

function makeRes() {
  let statusCode = 0;
  let body = '';
  const res = {
    writeHead(code: number, _h?: Record<string, string>) {
      statusCode = code;
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    get statusCode() { return statusCode; },
    get body() { return body; },
  };
}

describe('handleUpdateKey', () => {
  let updateRow: unknown = null;
  beforeEach(() => {
    vi.clearAllMocks();
    updateRow = null;
    // SQL-dispatch: control statements + the preflight/FOR-UPDATE reads
    // resolve against a present unbound key; UPDATE statements return the
    // per-test updateRow (tests set it).
    mocks.query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(text)) return { rows: [] };
      if (text.includes('UPDATE api_keys')) {
        return updateRow ?? { rows: [{ allowed_models: null, preset_slug: null, preset_version: null }], rowCount: 0 };
      }
      return { rows: [{ allowed_models: null, preset_slug: null, preset_version: null }] };
    });
  });

  it('returns 400 for invalid JSON', async () => {
    const out = makeRes();
    await handleUpdateKey(
      makeReq({ url: '/admin/keys/k1?team_id=team_1', body: '{' }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(400);
  });

  it('returns 400 when team_id is missing', async () => {
    const out = makeRes();
    await handleUpdateKey(
      makeReq({ url: '/admin/keys/k1', body: '{}' }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body).error.message).toMatch(/team_id/);
  });

  it('returns 400 when team_id is wildcard', async () => {
    const out = makeRes();
    await handleUpdateKey(
      makeReq({ url: '/admin/keys/k1?team_id=*', body: '{}' }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(400);
  });

  it('returns 400 for invalid allowed_models (not array of strings)', async () => {
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({ allowed_models: 'gpt-5' }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body).error.message).toMatch(/allowed_models/);
  });

  it('returns 400 for invalid expires_at (not parseable date)', async () => {
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({ expires_at: 'tomorrow' }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body).error.message).toMatch(/expires_at/);
  });

  it('returns 400 for invalid rate_limit_override (rpm not a positive number)', async () => {
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({ rate_limit_override: { requests_per_minute: -5 } }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(400);
  });

  it('returns 400 for invalid metadata (not an object)', async () => {
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({ metadata: ['tag1'] }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(400);
  });

  it('returns 404 when no key matches the (id, team_id) pair', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({ name: 'New name' }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(404);
  });

  it('returns 200 and the updated row on success, invalidates cache', async () => {
    updateRow = {
      rows: [{
        id: 'k1',
        team_id: 'team_1',
        key_hash: 'hash_xyz',
        key_prefix: 'rsk_live_team',
        name: 'Renamed',
        environment: 'live',
        allowed_models: ['gpt-5'],
        expires_at: null,
        rate_limit_override: { requests_per_minute: 50 },
        metadata: { customer_id: 'c_1' },
        preset_slug: null,
        preset_version: null,
        created_at: new Date('2026-04-01T00:00:00Z'),
        last_used: null,
      }],
      rowCount: 1,
    };
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({
          name: 'Renamed',
          allowed_models: ['gpt-5'],
          rate_limit_override: { requests_per_minute: 50 },
          metadata: { customer_id: 'c_1' },
        }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body);
    expect(body.id).toBe('k1');
    expect(body.name).toBe('Renamed');
    // key_hash must NOT be exposed in the response
    expect(body.key_hash).toBeUndefined();
    expect(mocks.invalidateKeyCache).toHaveBeenCalledWith('hash_xyz');
  });

  it('handles partial update — only the name changes, other columns left alone', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'k1', team_id: 'team_1', key_hash: 'h', key_prefix: 'p',
        name: 'New', environment: 'live', allowed_models: null,
        expires_at: null, rate_limit_override: null, metadata: {},
        created_at: new Date(), last_used: null,
      }],
      rowCount: 1,
    });
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({ name: 'New' }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(200);
    // Confirm the SQL only set `name` (and the WHERE clause).
    // calls[0] is the RSH-146 current-row read; the UPDATE is calls[1].
    const [sql, params] = mocks.query.mock.calls[1];
    expect(sql).toMatch(/UPDATE api_keys/);
    // The SET clause should mention only `name` — extract it to avoid being
    // tripped up by the RETURNING clause which legitimately lists all columns.
    const setClause = sql.match(/SET\s+([^]+?)\s+WHERE/)![1];
    expect(setClause).toMatch(/name = \$\d/);
    expect(setClause).not.toMatch(/allowed_models/);
    expect(setClause).not.toMatch(/rate_limit_override/);
    expect(params).toContain('New');
    expect(params).toContain('k1');
    expect(params).toContain('team_1');
  });

  it('accepts null to explicitly clear allowed_models / expires_at / rate_limit_override', async () => {
    updateRow = {
      rows: [{
        id: 'k1', team_id: 'team_1', key_hash: 'h', key_prefix: 'p',
        name: 'n', environment: 'live', allowed_models: null,
        expires_at: null, rate_limit_override: null, metadata: {},
        preset_slug: null, preset_version: null,
        created_at: new Date(), last_used: null,
      }],
      rowCount: 1,
    };
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({
          allowed_models: null,
          expires_at: null,
          rate_limit_override: null,
        }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(200);
    const updateCall = mocks.query.mock.calls.find((c) => String(c[0]).includes('UPDATE api_keys'))!;
    const [sql, params] = updateCall;
    const setClause = sql.match(/SET\s+([^]+?)\s+WHERE/)![1];
    expect(setClause).toMatch(/allowed_models/);
    expect(setClause).toMatch(/expires_at/);
    expect(setClause).toMatch(/rate_limit_override/);
    // Each of those nullable columns gets a null binding
    expect(params.filter((p: unknown) => p === null).length).toBeGreaterThanOrEqual(3);
  });

  it('returns 400 when no updatable fields are provided', async () => {
    const out = makeRes();
    await handleUpdateKey(
      makeReq({
        url: '/admin/keys/k1?team_id=team_1',
        body: JSON.stringify({ totally_unrelated: 'x' }),
      }),
      out.res,
      'k1',
    );
    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body).error.message).toMatch(/no updatable fields/i);
  });
});
