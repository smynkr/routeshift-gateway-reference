import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  checkLimit: vi.fn(),
  generateApiKey: vi.fn(),
  invalidateKeyCache: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

vi.mock('../src/billing/plan-limits.js', () => ({
  checkLimit: mocks.checkLimit,
}));

vi.mock('../src/auth/api-key.js', () => ({
  generateApiKey: mocks.generateApiKey,
  invalidateKeyCache: mocks.invalidateKeyCache,
}));

vi.mock('node:crypto', () => ({
  randomUUID: mocks.randomUUID,
}));

import { handleCreateKey, handleListKeys, handleRevokeKey, handleListTeamAudit } from '../src/admin/keys.js';

function makeReq(options?: { url?: string; body?: string }): IncomingMessage {
  const stream = Readable.from(options?.body !== undefined ? [Buffer.from(options.body)] : []);
  return Object.assign(stream, {
    url: options?.url ?? '/',
    headers: { host: 'localhost' },
  }) as IncomingMessage;
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

describe('admin keys handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.randomUUID.mockReturnValue('key-id-123');
    mocks.generateApiKey.mockReturnValue({
      key: 'rsk_live_secret',
      hash: 'hash_123',
      prefix: 'rsk_live',
    });
    mocks.checkLimit.mockResolvedValue({ allowed: true, current: 1, limit: 10 });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('returns 400 for invalid create JSON body', async () => {
    const out = makeRes();
    await handleCreateKey(makeReq({ body: '{' }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Invalid JSON in request body' } });
  });

  it('returns 400 for non-object create JSON payload', async () => {
    const out = makeRes();
    await handleCreateKey(makeReq({ body: '1' }), out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'Invalid JSON in request body' } });
  });

  it('returns 403 when key plan limit is reached', async () => {
    mocks.checkLimit.mockResolvedValueOnce({ allowed: false, current: 2, limit: 2 });
    const out = makeRes();

    await handleCreateKey(
      makeReq({ body: JSON.stringify({ team_id: 'team_1', name: 'Primary', environment: 'live' }) }),
      out.res,
    );

    expect(out.statusCode).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('returns 400 when team_id is missing or wildcard', async () => {
    const missing = makeRes();
    await handleCreateKey(makeReq({ body: JSON.stringify({ name: 'No team' }) }), missing.res);
    expect(missing.statusCode).toBe(400);

    const wildcard = makeRes();
    await handleCreateKey(makeReq({ body: JSON.stringify({ team_id: '*', name: 'Wildcard' }) }), wildcard.res);
    expect(wildcard.statusCode).toBe(400);

    expect(mocks.checkLimit).not.toHaveBeenCalled();
  });

  it('creates a key and persists its hash/prefix', async () => {
    const out = makeRes();

    await handleCreateKey(
      makeReq({ body: JSON.stringify({ team_id: 'team_1', name: 'Primary', environment: 'test' }) }),
      out.res,
    );

    expect(out.statusCode).toBe(201);
    // LAY-331 records an audit event via getPool() too, so query is called
    // a second time. Assert specifically on the INSERT, not the call count.
    expect(mocks.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO api_keys'),
      // LAY-340: handleCreateKey now persists allowed_models / expires_at /
      // rate_limit_override alongside the original 7 columns. Defaults are
      // null when the create body doesn't supply them.
      // RSH-138: the three budget cap columns follow the rate-limit override.
      // RSH-146: preset_slug + preset_version (both null when unbound) sit
      // between the rate override and the budget caps.
      ['key-id-123', 'team_1', 'hash_123', 'rsk_live', 'Primary', 'test', {}, null, null, null, null, null, null, null, null],
    );
    expect(JSON.parse(out.body)).toMatchObject({
      id: 'key-id-123',
      key: 'rsk_live_secret',
      prefix: 'rsk_live',
      name: 'Primary',
      environment: 'test',
    });
  });

  it('requires team_id when listing keys', async () => {
    const out = makeRes();
    await handleListKeys(makeReq({ url: '/admin/keys' }), out.res);

    expect(out.statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects wildcard team_id when revoking keys', async () => {
    const out = makeRes();
    await handleRevokeKey(makeReq({ url: '/admin/keys/key_1?team_id=*' }), out.res, 'key_1');

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'team_id wildcard is not allowed' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('lists active keys for a team', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ id: 'k_1', team_id: 'team_1', key_prefix: 'rsk_live' }],
      rowCount: 1,
    });
    const out = makeRes();

    await handleListKeys(makeReq({ url: '/admin/keys?team_id=team_1' }), out.res);

    expect(out.statusCode).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('WHERE revoked_at IS NULL'), ['team_1']);
    // The listing MUST return the restriction columns: the dashboard edit dialog
    // round-trips whatever this returns and re-sends every field on save, so
    // omitting these would let an edit to a key's name silently null out its
    // model allowlist and per-key rate cap (silent privilege broadening).
    const listSql = mocks.query.mock.calls[0][0] as string;
    expect(listSql).toContain('allowed_models');
    expect(listSql).toContain('rate_limit_override');
    expect(JSON.parse(out.body)).toEqual([{ id: 'k_1', team_id: 'team_1', key_prefix: 'rsk_live' }]);
  });

  it('revokes a team-scoped key and invalidates cache', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ team_id: 'team_1', key_hash: 'hash_to_invalidate' }],
      rowCount: 1,
    });
    const out = makeRes();

    await handleRevokeKey(makeReq({ url: '/admin/keys/key_1?team_id=team_1' }), out.res, 'key_1');

    expect(out.statusCode).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE api_keys SET revoked_at = now()'),
      ['key_1', 'team_1'],
    );
    expect(mocks.invalidateKeyCache).toHaveBeenCalledWith('hash_to_invalidate');
    expect(JSON.parse(out.body)).toEqual({ revoked: true });
  });

  it('revokes by key id without team_id for Axiom Layer admin integration', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ team_id: 'team_1', key_hash: 'hash_to_invalidate' }],
      rowCount: 1,
    });
    const out = makeRes();

    await handleRevokeKey(makeReq({ url: '/admin/keys/key_1' }), out.res, 'key_1');

    expect(out.statusCode).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1 AND revoked_at IS NULL'),
      ['key_1'],
    );
    expect(mocks.invalidateKeyCache).toHaveBeenCalledWith('hash_to_invalidate');
    expect(JSON.parse(out.body)).toEqual({ revoked: true });
  });

  it('returns 404 when key is not found during revocation', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const out = makeRes();

    await handleRevokeKey(makeReq({ url: '/admin/keys/key_404?team_id=team_1' }), out.res, 'key_404');

    expect(out.statusCode).toBe(404);
    expect(mocks.invalidateKeyCache).not.toHaveBeenCalled();
  });
});

describe('handleListTeamAudit key_prefix escaping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
  });

  it('escapes LIKE metacharacters and adds an ESCAPE clause', async () => {
    const out = makeRes();
    // key_prefix decodes to `rsk_li%` — an unescaped `_`/`%` would widen the
    // prefix filter past a literal match across the whole team feed.
    await handleListTeamAudit(
      makeReq({ url: '/admin/keys/audit?team_id=team_1&key_prefix=rsk_li%25' }),
      out.res,
    );

    const auditCall = mocks.query.mock.calls.find(([sql]: [string]) =>
      /api_key_audit_events/i.test(sql),
    );
    expect(auditCall).toBeDefined();
    const [sql, params] = auditCall as [string, unknown[]];
    expect(sql).toContain('key_prefix LIKE');
    expect(sql).toContain("ESCAPE '\\'");
    // `_` and `%` are backslash-escaped before the trailing prefix wildcard.
    expect(params).toContain('rsk\\_li\\%%');
  });

  it('leaves an ordinary prefix untouched apart from the trailing wildcard', async () => {
    const out = makeRes();
    await handleListTeamAudit(
      makeReq({ url: '/admin/keys/audit?team_id=team_1&key_prefix=rsk_live' }),
      out.res,
    );

    const auditCall = mocks.query.mock.calls.find(([sql]: [string]) =>
      /api_key_audit_events/i.test(sql),
    );
    const [, params] = auditCall as [string, unknown[]];
    expect(params).toContain('rsk\\_live%');
  });

  it('RSH-86: returns 403 when body.team_id does not match query team_id (cross-tenant defense)', async () => {
    const out = makeRes();
    await handleCreateKey(
      makeReq({
        url: '/admin/keys?team_id=team_authorized',
        body: JSON.stringify({ team_id: 'team_other', name: 'Cross-tenant key' }),
      }),
      out.res,
    );

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({ error: { message: 'body team_id does not match query team_id' } });
    // Must not call the DB — reject early before any INSERT
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('RSH-86: allows create when body.team_id matches query team_id', async () => {
    const out = makeRes();
    await handleCreateKey(
      makeReq({
        url: '/admin/keys?team_id=team_1',
        body: JSON.stringify({ team_id: 'team_1', name: 'Matching key' }),
      }),
      out.res,
    );

    // Should succeed (201) because body and query team_ids match
    expect(out.statusCode).toBe(201);
  });
});
