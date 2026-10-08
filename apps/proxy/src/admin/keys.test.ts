import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
// handleListTeamAudit uses pool.query() directly; handleRotateKey uses a
// pool.connect()-returned client for its BEGIN/…/COMMIT transaction. Both
// route through the same queryMock so a single mockImplementation keyed off
// SQL text works for either call shape.
vi.mock('../db/pool.js', () => ({
  getPool: () => ({
    query: queryMock,
        connect: async () => ({
      // BEGIN/COMMIT/ROLLBACK never touch the assertion spy, so existing
      // mockResolvedValueOnce sequences keep targeting real statements.
      query: async (sql: unknown, params?: unknown[]) => {
        if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(String(sql))) return { rows: [] };
        return queryMock(sql, params);
      },
      release: releaseMock,
    }),
  }),
}));

import { handleListKeyAudit, handleListTeamAudit, handleRotateKey } from './keys.js';

function makeRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers: Record<string, string>) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
    },
  };
}

describe('handleListTeamAudit', () => {
  beforeEach(() => queryMock.mockReset());

  it('event_type=sso_issued actually filters instead of silently returning everything', async () => {
    // Only the matching row would come back from a real DB query with the
    // filter applied; what we're really asserting is that the predicate was
    // sent to pool.query() at all -- prior to wiring 'sso_issued' into
    // TEAM_AUDIT_EVENT_TYPES, this event_type value was silently dropped
    // from `where`/`params` and the query ran unfiltered.
    queryMock.mockResolvedValue({
      rows: [
        {
          id: 'evt-2',
          api_key_id: 'key-1',
          key_prefix: 'sk-proxy-live_abcd',
          event_type: 'sso_issued',
          actor_user_id: null,
          details: {},
          created_at: new Date('2026-07-01T00:00:00Z'),
        },
      ],
    });
    const teamId = 'team_ab12cd34';
    const res = makeRes();
    await handleListTeamAudit(
      { url: `/admin/keys/audit?team_id=${teamId}&event_type=sso_issued` } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('event_type = $');
    expect(params).toContain('sso_issued');

    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event_type).toBe('sso_issued');
  });

  it('rotated also filters (was missing from the allowlist alongside sso_issued)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const teamId = 'team_ab12cd34';
    const res = makeRes();
    await handleListTeamAudit(
      { url: `/admin/keys/audit?team_id=${teamId}&event_type=rotated` } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('event_type = $');
    expect(params).toContain('rotated');
  });

  it('an unrecognized event_type 400s instead of silently widening to the unfiltered feed', async () => {
    // AXI-7 review fix: previously an unknown event_type was dropped from the
    // filter and the query ran UNFILTERED — returning more than the caller
    // asked for. The contract is now fail-closed: 400 and no DB query at all.
    queryMock.mockResolvedValue({ rows: [] });
    const teamId = 'team_ab12cd34';
    const res = makeRes();
    await handleListTeamAudit(
      { url: `/admin/keys/audit?team_id=${teamId}&event_type=not_a_real_type` } as never,
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.message).toMatch(/unsupported event_type/);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('handleListKeyAudit key id validation', () => {
  beforeEach(() => queryMock.mockReset());

  it('accepts a canonical UUID and binds it to the audit query', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const keyId = '11111111-2222-4333-8444-555555555555';
    const res = makeRes();

    await handleListKeyAudit(
      { url: `/admin/keys/${keyId}/audit?team_id=team_1` } as never,
      res as never,
      keyId,
    );

    expect(res.statusCode).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0]?.[1]).toEqual(['team_1', keyId, 50]);
  });

  it.each([
    'not-a-uuid',
    '11111111-2222-4333-8444-55555555555',
    '11111111-2222-4333-8444-555555555555%252Fextra',
    '11111111-2222-4333-8444-555555555555%2Fextra',
  ])('rejects malformed/noncanonical key id %s before querying the database', async (keyId) => {
    const res = makeRes();

    await handleListKeyAudit(
      { url: `/admin/keys/${keyId}/audit?team_id=team_1` } as never,
      res as never,
      keyId,
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: { message: 'key_id must be a valid UUID' } });
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// Broader handleRotateKey coverage — including the metadata-carrying /
// normal-rotation happy-path cases — lives in
// apps/proxy/tests/admin-keys-rotate.test.ts. This file only covers the
// SSO-rejection case, which was added here rather than there because it
// predates noticing the existing suite (see PR review on dcce676).
describe('handleRotateKey', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
  });

  function makeReq(url: string) {
    return {
      url,
      // handleRotateKey does `for await (const chunk of req)` to read the
      // (optional) body. An empty body is explicitly supported ("use the
      // default grace window"), so a zero-chunk async iterable is enough
      // for this test.
      [Symbol.asyncIterator]: async function* () {},
    };
  }

  it('rejects rotation of an SSO-issued key with a clean error, not a 500', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({
          rows: [
            {
              id: 'key-1',
              key_hash: 'hash-1',
              key_prefix: 'sk-proxy-live_abcd',
              environment: 'live',
              allowed_models: null,
              rate_limit_override: null,
              metadata: { issued_via: 'sso_device_flow' },
            },
          ],
        });
      }
      // BEGIN / ROLLBACK / anything else
      return Promise.resolve({ rows: [] });
    });

    const teamId = 'team_ab12cd34';
    const keyId = 'key-1';
    const res = makeRes();
    const req = makeReq(`/admin/keys/${keyId}/rotate?team_id=${teamId}`);

    await handleRotateKey(req as never, res as never, keyId);

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error.message).toMatch(/sso/i);
    expect(body.error.message).toMatch(/re-authenticate/i);

    const insertCalls = queryMock.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO api_keys'),
    );
    expect(insertCalls).toHaveLength(0);
    expect(releaseMock).toHaveBeenCalled();
  });
});

// RSH-138: per-key budget cap fields round-trip through create/update/list
// with exact validation and omitted-field preservation.
import { handleCreateKey, handleListKeys, handleUpdateKey } from './keys.js';

describe('handleCreateKey budget caps (RSH-138)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    // checkLimit's COUNT query runs before cap parsing on every create.
    queryMock.mockResolvedValue({ rows: [{ count: 0 }] });
  });

  function makeCreateReq(body: unknown) {
    const req = {
      url: '/admin/keys',
      method: 'POST',
      headers: {},
    };
    const chunks = [Buffer.from(JSON.stringify(body))];
    (req as never as { on: unknown }).on = undefined;
    (req as never as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] = async function* () {
      for (const chunk of chunks) yield chunk;
    };
    return req as never;
  }

  it('accepts all three cap fields on create and stores exact microcents', async () => {
    // checkLimit runs TWO queries on a cold plan cache (plan SELECT + COUNT)
    // and one on a warm cache, so query ORDER is not stable. The default mock
    // answers every query with a countable row; locate the INSERT by SQL.
    const res = makeRes();
    await handleCreateKey(
      makeCreateReq({ team_id: 'team_1', name: 'caps', daily_usd_cap: 0.07, weekly_usd_cap: 8.29, monthly_usd_cap: 99.99 }),
      res as never,
    );

    expect(res.statusCode).toBe(201);
    const insert = queryMock.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO api_keys'),
    );
    expect(insert).toBeDefined();
    const params = insert![1] as unknown[];
    // USD columns: exact microcent validation, USD persistence.
    // RSH-146: preset_slug + preset_version occupy indices 10-11.
    expect(params[12]).toBeCloseTo(0.07, 10);
    expect(params[13]).toBeCloseTo(8.29, 10);
    expect(params[14]).toBeCloseTo(99.99, 10);
    const body = JSON.parse(res.body);
    expect(body.daily_usd_cap).toBe(0.07);
    expect(body.weekly_usd_cap).toBe(8.29);
    expect(body.monthly_usd_cap).toBe(99.99);
  });

  it('rejects an invalid cap before any SQL', async () => {
    const res = makeRes();
    await handleCreateKey(
      makeCreateReq({ team_id: 'team_1', name: 'bad', monthly_usd_cap: -5 }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    // Only the checkLimit COUNT ran; the cap INSERT never executed.
    expect(queryMock.mock.calls.map((c) => String(c[0]))).not.toEqual(expect.arrayContaining([expect.stringContaining('INSERT INTO api_keys')]));
  });

  it('rejects a sub-microcent cap before any SQL', async () => {
    const res = makeRes();
    await handleCreateKey(
      makeCreateReq({ team_id: 'team_1', name: 'bad', weekly_usd_cap: 0.000000001 }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(queryMock.mock.calls.map((c) => String(c[0]))).not.toEqual(expect.arrayContaining([expect.stringContaining('INSERT INTO api_keys')]));
  });
});

describe('handleListKeys budget caps (RSH-138)', () => {
  beforeEach(() => queryMock.mockReset());

  it('selects the three cap columns', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await handleListKeys({ url: '/admin/keys?team_id=team_1' } as never, res as never);

    expect(String(queryMock.mock.calls[0]![0])).toContain('daily_usd_cap, weekly_usd_cap, monthly_usd_cap');
  });
});

describe('handleUpdateKey budget caps (RSH-138)', () => {
  beforeEach(() => queryMock.mockReset());

  function makePatchReq(body: unknown) {
    const req = { url: '/admin/keys/key_1?team_id=team_1', method: 'PATCH' };
    (req as never as { [Symbol.asyncIterator]: unknown })[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(JSON.stringify(body));
    };
    return req as never;
  }

  it('preserves omitted caps and clears exactly the explicit null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ allowed_models: null, preset_slug: null, preset_version: null }] }); // RSH-146 current-row read
    queryMock.mockResolvedValue({
      rows: [{
        id: 'key_1', team_id: 'team_1', key_hash: 'h', key_prefix: 'sk-proxy-live_ab',
        name: 'k', environment: 'live', allowed_models: null, expires_at: null,
        rate_limit_override: null, metadata: {}, daily_usd_cap: '0.07000000',
        weekly_usd_cap: null, monthly_usd_cap: null, preset_slug: null, preset_version: null,
        created_at: new Date(), last_used: null,
      }],
    });
    const res = makeRes();
    await handleUpdateKey(makePatchReq({ daily_usd_cap: null }), res as never, 'key_1');

    expect(res.statusCode).toBe(200);
    // calls[0] is the RSH-146 current-row read; the UPDATE is calls[1]
    const update = queryMock.mock.calls[1]!;
    const sql = String(update[0]);
    expect(sql).toContain('daily_usd_cap');
    expect(sql).not.toContain('weekly_usd_cap =');
    expect(sql).not.toContain('monthly_usd_cap =');
    const params = update[1] as unknown[];
    expect(params[0]).toBeNull(); // explicit null clears daily only
  });

  it('applies a provided cap value and rejects invalid ones before SQL', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ allowed_models: null, preset_slug: null, preset_version: null }] }); // RSH-146 current-row read
    queryMock.mockResolvedValue({
      rows: [{
        id: 'key_1', team_id: 'team_1', key_hash: 'h', key_prefix: 'sk-proxy-live_ab',
        name: 'k', environment: 'live', allowed_models: null, expires_at: null,
        rate_limit_override: null, metadata: {}, daily_usd_cap: null,
        weekly_usd_cap: '50.00000000', monthly_usd_cap: null, preset_slug: null, preset_version: null,
        created_at: new Date(), last_used: null,
      }],
    });
    const res = makeRes();
    await handleUpdateKey(makePatchReq({ weekly_usd_cap: 50 }), res as never, 'key_1');
    expect(res.statusCode).toBe(200);
    const params = queryMock.mock.calls[1]![1] as unknown[];
    expect(params[0]).toBeCloseTo(50, 10);

    queryMock.mockReset();
    const bad = makeRes();
    await handleUpdateKey(makePatchReq({ monthly_usd_cap: -1 }), bad as never, 'key_1');
    expect(bad.statusCode).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
