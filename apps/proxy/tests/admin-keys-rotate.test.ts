import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  invalidateKeyCache: vi.fn(),
  generateApiKey: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query, connect: mocks.connect }),
}));

vi.mock('../src/auth/api-key.js', () => ({
  invalidateKeyCache: mocks.invalidateKeyCache,
  generateApiKey: mocks.generateApiKey,
}));

vi.mock('../src/billing/plan-limits.js', () => ({
  checkLimit: vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 100 }),
}));

vi.mock('../src/auth/audit-events.js', () => ({
  recordAuditEvent: mocks.recordAuditEvent,
}));

import { handleRotateKey } from '../src/admin/keys.js';

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
    writeHead(code: number) {
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

interface ClientCalls {
  begin: number;
  commit: number;
  rollback: number;
  insertNew: number;
  updateOld: number;
  selectOldArgs: unknown[];
  insertArgs: unknown[];
  updateArgs: unknown[];
}

function makeClient(opts: {
  selectOldRows?: any[];
  selectOldThrows?: Error;
  updateRows?: any[];
}) {
  const calls: ClientCalls = {
    begin: 0,
    commit: 0,
    rollback: 0,
    insertNew: 0,
    updateOld: 0,
    selectOldArgs: [],
    insertArgs: [],
    updateArgs: [],
  };

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const trimmed = sql.trim();
      if (trimmed === 'BEGIN') { calls.begin++; return {}; }
      if (trimmed === 'COMMIT') { calls.commit++; return {}; }
      if (trimmed === 'ROLLBACK') { calls.rollback++; return {}; }
      if (trimmed.startsWith('SELECT id, key_hash')) {
        calls.selectOldArgs = params ?? [];
        if (opts.selectOldThrows) throw opts.selectOldThrows;
        return { rows: opts.selectOldRows ?? [] };
      }
      if (trimmed.startsWith('INSERT INTO api_keys')) {
        calls.insertNew++;
        calls.insertArgs = params ?? [];
        return { rows: [] };
      }
      if (trimmed.startsWith('UPDATE api_keys')) {
        calls.updateOld++;
        calls.updateArgs = params ?? [];
        return { rows: opts.updateRows ?? [{ rotation_grace_until: '2026-04-30T09:57:00.000Z' }] };
      }
      throw new Error(`Unexpected SQL in test: ${trimmed.slice(0, 60)}`);
    }),
    release: vi.fn(),
  };
  return { client, calls };
}

// The SSO-rejection case (metadata.issued_via === 'sso_device_flow') lives in
// src/admin/keys.test.ts, not here — it uses a different mock strategy
// (a single queryMock keyed off SQL text rather than this file's makeClient).
describe('handleRotateKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateApiKey.mockReturnValue({
      key: 'sk-proxy-live_team_NEW',
      hash: 'newhashdeadbeef',
      prefix: 'sk-proxy-live_team',
    });
  });

  it('rejects missing team_id', async () => {
    const req = makeReq({ url: '/admin/keys/key-1/rotate', body: '' });
    const out = makeRes();
    const res = out.res;
    await handleRotateKey(req, res, 'key-1');
    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('team_id');
  });

  it('rejects malformed JSON body', async () => {
    const req = makeReq({ url: '/admin/keys/key-1/rotate?team_id=team_a', body: '{not json' });
    const out = makeRes();
    const res = out.res;
    await handleRotateKey(req, res, 'key-1');
    expect(out.statusCode).toBe(400);
  });

  it.each([
    [-1, 'negative'],
    [0, 'zero'],
    [169, 'over MAX'],
    [1.5, 'non-integer'],
    ['24', 'wrong type'],
  ])('rejects grace_hours=%s (%s)', async (graceHours) => {
    const req = makeReq({
      url: '/admin/keys/key-1/rotate?team_id=team_a',
      body: JSON.stringify({ grace_hours: graceHours }),
    });
    const out = makeRes();
    const res = out.res;
    await handleRotateKey(req, res, 'key-1');
    expect(out.statusCode).toBe(400);
    expect(out.body).toContain('grace_hours');
  });

  it('returns 404 when key not found or already revoked', async () => {
    const { client, calls } = makeClient({ selectOldRows: [] });
    mocks.connect.mockResolvedValue(client);
    const req = makeReq({
      url: '/admin/keys/key-1/rotate?team_id=team_a',
      body: JSON.stringify({ grace_hours: 24 }),
    });
    const out = makeRes();
    const res = out.res;
    await handleRotateKey(req, res, 'key-1');
    expect(out.statusCode).toBe(404);
    expect(calls.rollback).toBe(1);
    expect(calls.insertNew).toBe(0);
  });

  it('rotates: inserts new key, sets grace, audits, returns new key', async () => {
    const { client, calls } = makeClient({
      selectOldRows: [{
        id: 'old-id',
        key_hash: 'oldhash',
        key_prefix: 'sk-proxy-live_team',
        environment: 'live',
      }],
      updateRows: [{ rotation_grace_until: '2026-04-30T10:00:00.000Z' }],
    });
    mocks.connect.mockResolvedValue(client);

    const req = makeReq({
      url: '/admin/keys/old-id/rotate?team_id=team_a&actor_user_id=u-1',
      body: JSON.stringify({ grace_hours: 48 }),
    });
    const out = makeRes();
    const res = out.res;
    await handleRotateKey(req, res, 'old-id');

    expect(out.statusCode).toBe(201);
    const parsed = JSON.parse(out.body);
    expect(parsed.new_key).toBe('sk-proxy-live_team_NEW');
    expect(parsed.new_prefix).toBe('sk-proxy-live_team');
    expect(parsed.environment).toBe('live');
    expect(parsed.grace_until).toBe('2026-04-30T10:00:00.000Z');

    expect(calls.begin).toBe(1);
    expect(calls.commit).toBe(1);
    expect(calls.rollback).toBe(0);
    expect(calls.insertNew).toBe(1);
    expect(calls.updateOld).toBe(1);

    // Update params shape: [newId, '48', keyId, teamId]
    expect(calls.updateArgs[1]).toBe('48');
    expect(calls.updateArgs[2]).toBe('old-id');
    expect(calls.updateArgs[3]).toBe('team_a');

    expect(mocks.invalidateKeyCache).toHaveBeenCalledWith('oldhash');
    expect(mocks.recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      team_id: 'team_a',
      api_key_id: 'old-id',
      key_prefix: 'sk-proxy-live_team',
      event_type: 'rotated',
      actor_user_id: 'u-1',
      details: expect.objectContaining({ grace_hours: 48 }),
    }));
  });

  it('carries the original key restrictions onto the rotated key (no silent privilege broadening)', async () => {
    const allowed = ['gpt-4.1'];
    const rateCap = { requests_per_minute: 10, tokens_per_minute: 1000 };
    const meta = { owner: 'research' };
    const { client, calls } = makeClient({
      selectOldRows: [{
        id: 'old-id',
        key_hash: 'oldhash',
        key_prefix: 'sk-proxy-live_team',
        environment: 'live',
        allowed_models: allowed,
        rate_limit_override: rateCap,
        metadata: meta,
      }],
    });
    mocks.connect.mockResolvedValue(client);
    const req = makeReq({
      url: '/admin/keys/old-id/rotate?team_id=team_a',
      body: JSON.stringify({ grace_hours: 24 }),
    });
    const out = makeRes();
    await handleRotateKey(req, out.res, 'old-id');

    expect(out.statusCode).toBe(201);
    // INSERT binds [id, team, hash, prefix, name, environment, allowed_models,
    // rate_limit_override, metadata] — the rotated key must keep the original's
    // model allowlist + rate cap + metadata, not reset to unrestricted defaults.
    expect(calls.insertArgs[6]).toEqual(allowed);
    expect(calls.insertArgs[7]).toEqual(rateCap);
    expect(calls.insertArgs[8]).toEqual(meta);
  });

  it('defaults grace_hours to 24 when omitted', async () => {
    const { client, calls } = makeClient({
      selectOldRows: [{
        id: 'old-id',
        key_hash: 'oldhash',
        key_prefix: 'sk-proxy-live_team',
        environment: 'live',
      }],
    });
    mocks.connect.mockResolvedValue(client);

    const req = makeReq({
      url: '/admin/keys/old-id/rotate?team_id=team_a',
      body: '',
    });
    const out = makeRes();
    const res = out.res;
    await handleRotateKey(req, res, 'old-id');

    expect(out.statusCode).toBe(201);
    expect(calls.updateArgs[1]).toBe('24');
  });

  it('rolls back and returns 500 when SELECT throws', async () => {
    const { client, calls } = makeClient({ selectOldThrows: new Error('db down') });
    mocks.connect.mockResolvedValue(client);
    const req = makeReq({
      url: '/admin/keys/old-id/rotate?team_id=team_a',
      body: JSON.stringify({ grace_hours: 24 }),
    });
    const out = makeRes();
    const res = out.res;
    await handleRotateKey(req, res, 'old-id');
    expect(out.statusCode).toBe(500);
    expect(calls.rollback).toBe(1);
    expect(client.release).toHaveBeenCalled();
    expect(mocks.recordAuditEvent).not.toHaveBeenCalled();
  });

  it('preserves test environment in the rotated key', async () => {
    const { client } = makeClient({
      selectOldRows: [{
        id: 'old-id',
        key_hash: 'oldhash',
        key_prefix: 'sk-proxy-test_team',
        environment: 'test',
      }],
    });
    mocks.connect.mockResolvedValue(client);

    const req = makeReq({
      url: '/admin/keys/old-id/rotate?team_id=team_a',
      body: JSON.stringify({ grace_hours: 24 }),
    });
    const out = makeRes();
    const res = out.res;
    await handleRotateKey(req, res, 'old-id');
    expect(out.statusCode).toBe(201);
    expect(JSON.parse(out.body).environment).toBe('test');
    expect(mocks.generateApiKey).toHaveBeenCalledWith('team_a', 'test');
  });
});
