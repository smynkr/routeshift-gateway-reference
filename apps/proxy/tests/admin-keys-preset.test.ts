/**
 * RSH-146: key minting as a policy act — preset binding accepted at mint,
 * editable, carried through rotation, and consistency-checked against the
 * key's allowed_models. Pool + preset resolver mocked (SQL text and params
 * are the contract under test).
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  checkLimit: vi.fn(),
  generateApiKey: vi.fn(),
  invalidateKeyCache: vi.fn(),
  resolvePreset: vi.fn(),
  parsePresetRef: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({
    query: mocks.query,
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

vi.mock('../src/billing/plan-limits.js', () => ({ checkLimit: mocks.checkLimit }));

vi.mock('../src/auth/api-key.js', () => ({
  generateApiKey: mocks.generateApiKey,
  invalidateKeyCache: mocks.invalidateKeyCache,
}));

vi.mock('../src/presets/resolver.js', () => ({
  resolvePreset: mocks.resolvePreset,
  parsePresetRef: mocks.parsePresetRef,
}));

vi.mock('node:crypto', () => ({ randomUUID: mocks.randomUUID }));

import { handleCreateKey, handleRotateKey, handleUpdateKey } from '../src/admin/keys.js';

function makeReq(body: unknown, url = '/admin/keys/key_1?team_id=team_1') {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url }) as never;
}

function makeRes() {
  const state = { statusCode: 0, body: '' };
  return {
    writeHead: (code: number) => { state.statusCode = code; },
    end: (body: string) => { state.body = body; },
    state,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // default: BEGIN/COMMIT/ROLLBACK + the preflight/FOR-UPDATE reads of a
  // present unbound key; tests mock ONCE for the UPDATE RETURNING row
  mocks.query.mockImplementation(() => Promise.resolve({
    rows: [{ allowed_models: null, preset_slug: null, preset_version: null }],
  }));
  mocks.checkLimit.mockResolvedValue({ allowed: true });
  mocks.generateApiKey.mockReturnValue({ key: 'sk-proxy-x', hash: 'h', prefix: 'sk-proxy-x' });
  mocks.parsePresetRef.mockImplementation((ref: string) => {
    const m = /^([a-z0-9][a-z0-9-]{0,63})(?:@(\d+))?$/.exec(ref);
    return m ? { slug: m[1], version: m[2] ? Number(m[2]) : undefined } : null;
  });
});

describe('key preset binding (RSH-146)', () => {
  it('mints a key with a preset binding (slug + version stored)', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }); // INSERT
    mocks.resolvePreset.mockResolvedValueOnce({ model: 'gpt-5.4', params: {}, system_prompt: null, provider_prefs: null });
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleCreateKey(makeReq({
      team_id: 'team_1', name: 'policy key', allowed_models: ['gpt-5.4'], preset: 'support-bot@2',
    }), res);

    expect(res.state.statusCode).toBe(201);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('preset_slug');
    expect(params).toContain('support-bot');
    expect(params).toContain(2);
    expect(mocks.resolvePreset).toHaveBeenCalledWith('team_1', 'support-bot@2', { bypassCache: true });
    const body = JSON.parse(res.state.body);
    expect(body.preset_slug).toBe('support-bot');
    expect(body.preset_version).toBe(2);
  });

  it('rejects an unknown or disabled preset at mint', async () => {
    mocks.resolvePreset.mockResolvedValueOnce(null);
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleCreateKey(makeReq({ team_id: 'team_1', preset: 'nope' }), res);

    expect(res.state.statusCode).toBe(400);
    expect(JSON.parse(res.state.body).error.message).toContain('preset_not_found');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a binding whose model is outside the key allowed_models (unsatisfiable)', async () => {
    mocks.resolvePreset.mockResolvedValueOnce({ model: 'claude-opus-4-8', params: {}, system_prompt: null, provider_prefs: null });
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleCreateKey(makeReq({ team_id: 'team_1', allowed_models: ['gpt-5.4'], preset: 'support-bot' }), res);

    expect(res.state.statusCode).toBe(400);
    expect(JSON.parse(res.state.body).error.message).toContain("not in this key's allowed_models");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects malformed preset syntax', async () => {
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleCreateKey(makeReq({ team_id: 'team_1', preset: '../bad' }), res);

    expect(res.state.statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('mints a binding whose preset model carries a suffix against a canonical allowlist', async () => {
    // Dispatch strips suffixes before the allowlist gate (resolveRequestedModels),
    // so the mint-time check must compare the canonical form too — a
    // 'gpt-5.4:floor' preset model IS satisfiable against ['gpt-5.4'].
    mocks.query.mockResolvedValueOnce({ rows: [] }); // INSERT
    mocks.resolvePreset.mockResolvedValueOnce({ model: 'gpt-5.4:floor', params: {}, system_prompt: null, provider_prefs: null });
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleCreateKey(makeReq({
      team_id: 'team_1', name: 'policy key', allowed_models: ['gpt-5.4'], preset: 'support-bot',
    }), res);

    expect(res.state.statusCode).toBe(201);
  });

  it('rejects a binding whose model is outside the SNAPSHOT allowlist (concurrent narrowing)', async () => {
    // PATCH { preset: 'support-bot' } — the preflight reads an allowlist that
    // a concurrent PATCH narrows before the FOR-UPDATE lock lands. The in-tx
    // re-check must catch the stale preflight or the committed binding would
    // 403 every dispatch (bricked key).
    mocks.query
      .mockResolvedValueOnce({ rows: [{ allowed_models: null }] }) // preflight: not yet narrowed
      .mockResolvedValueOnce({ rows: [{ allowed_models: ['other-model'], preset_slug: null, preset_version: null }] }); // FOR UPDATE: narrowing committed
    mocks.resolvePreset.mockResolvedValueOnce({ model: 'gpt-5.4', params: {}, system_prompt: null, provider_prefs: null });
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleUpdateKey(makeReq({ preset: 'support-bot', name: 'x' }), res, 'key_1');

    expect(res.state.statusCode).toBe(400);
    expect(JSON.parse(res.state.body).error.message).toContain("not in this key's allowed_models");
    expect(mocks.query).toHaveBeenCalledTimes(2); // preflight + FOR UPDATE; UPDATE never ran
  });

  it('409s when the binding changed between preflight and lock (concurrent bind)', async () => {
    // PATCH { allowed_models: [...] } — the preflight sees an unbound key, but
    // a concurrent PATCH binds a preset before the FOR-UPDATE lock lands. The
    // preflight-resolved orphan model is untrustworthy; fail closed with 409.
    mocks.query
      .mockResolvedValueOnce({ rows: [{ preset_slug: null, preset_version: null }] }) // preflight: unbound
      .mockResolvedValueOnce({ rows: [{ allowed_models: null, preset_slug: 'support-bot', preset_version: null }] }); // FOR UPDATE: bound concurrently
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleUpdateKey(makeReq({ allowed_models: ['gpt-5.4'] }), res, 'key_1');

    expect(res.state.statusCode).toBe(409);
    expect(JSON.parse(res.state.body).error.code).toBe('key_concurrent_modification');
    expect(mocks.query).toHaveBeenCalledTimes(2); // preflight + FOR UPDATE; UPDATE never ran
  });

  it('updates the binding and clears it with null', async () => {
    // update with a new binding: preflight + FOR UPDATE use the default
    // current-row; the UPDATE RETURNING is mocked
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'k1', key_prefix: 'p', preset_slug: 'support-bot', preset_version: 3 }] }); // UPDATE RETURNING
    mocks.resolvePreset.mockResolvedValue({ model: 'gpt-5.4', params: {}, system_prompt: null, provider_prefs: null });
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleUpdateKey(makeReq({ preset: 'support-bot@3' }), res, 'key_1');

    expect(res.state.statusCode).toBe(200);
    // calls: [0] preflight, [1] FOR UPDATE, [2] UPDATE
    const [sql, params] = mocks.query.mock.calls[2];
    expect(sql).toContain('preset_slug');
    expect(params).toContain('support-bot');
    expect(params).toContain(3);

    // now CLEAR with explicit null: both columns must become null
    mocks.query.mockClear();
    mocks.resolvePreset.mockClear();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'k1', key_prefix: 'p', preset_slug: null, preset_version: null }] }); // UPDATE RETURNING
    const res2 = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleUpdateKey(makeReq({ preset: null }), res2, 'key_1');

    expect(res2.state.statusCode).toBe(200);
    const [sql2, params2] = mocks.query.mock.calls[2];
    expect(sql2).toContain('preset_slug');
    expect(params2).toContain(null);
    expect(mocks.resolvePreset).not.toHaveBeenCalledWith('team_1', expect.stringContaining('support-bot@')); // clearing revalidates nothing
  });

  it('rotation carries the preset binding AND budget caps/expiry (restricted key in → restricted key out)', async () => {
    // SELECT (FOR UPDATE) + INSERT + UPDATE rotation_grace + COMMIT
    mocks.query.mockResolvedValueOnce({
      rows: [{
        id: 'key_1', key_hash: 'h', key_prefix: 'sk-proxy-live_ab', environment: 'live',
        allowed_models: ['gpt-5.4'], rate_limit_override: null, metadata: {},
        preset_slug: 'support-bot', preset_version: 2,
        expires_at: new Date('2026-09-01T00:00:00Z'),
        daily_usd_cap: '0.07000000', weekly_usd_cap: '8.29000000', monthly_usd_cap: '99.99000000',
      }],
    });
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT
    mocks.query.mockResolvedValueOnce({ rows: [{ rotation_grace_until: '2026-08-12T00:00:00Z' }] }); // grace UPDATE
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleRotateKey(
      Object.assign(Readable.from([Buffer.from('{}')]), { url: '/admin/keys/key_1/rotate?team_id=team_1' }) as never,
      res,
      'key_1',
    );

    expect(res.state.statusCode).toBe(201);
    const insert = mocks.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO api_keys'));
    expect(insert).toBeDefined();
    const params = insert![1] as unknown[];
    // preset fields at 9-10; expiry at 11; caps at 12-14
    expect(params[9]).toBe('support-bot');
    expect(params[10]).toBe(2);
    expect(params[11]).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(params[12]).toBe('0.07000000');
    expect(params[13]).toBe('8.29000000');
    expect(params[14]).toBe('99.99000000');
    const body = JSON.parse(res.state.body);
    expect(body.preset_slug).toBe('support-bot');
    expect(body.daily_usd_cap).toBe(0.07);
  });

  it('rejects an allowed_models narrowing that would orphan an existing binding (version-pinned ref honored)', async () => {
    // preflight + FOR UPDATE both read the bound key — persistent mock
    mocks.query.mockResolvedValue({ rows: [{ allowed_models: ['gpt-5.4'], preset_slug: 'support-bot', preset_version: 2 }] });
    // the bound preset RESOLVES but its model is outside the new allowlist
    mocks.resolvePreset.mockResolvedValueOnce({ model: 'gpt-5.4', params: {}, system_prompt: null, provider_prefs: null });
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleUpdateKey(makeReq({ allowed_models: ['gpt-5.5'] }), res, 'key_1');

    expect(res.state.statusCode).toBe(400);
    expect(JSON.parse(res.state.body).error.message).toContain('orphan');
    // the re-check must use the PINNED ref, not the latest version
    expect(mocks.resolvePreset).toHaveBeenLastCalledWith('team_1', 'support-bot@2', { bypassCache: true });
    expect(mocks.query).toHaveBeenCalledTimes(2); // preflight + FOR UPDATE; UPDATE never ran
  });

  it('does NOT block unrelated updates when the bound preset is already dead (deleted/disabled)', async () => {
    mocks.query.mockResolvedValue({ rows: [{ allowed_models: ['gpt-5.4'], preset_slug: 'support-bot', preset_version: null }] }); // preflight + FOR UPDATE
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'k1', key_prefix: 'p', allowed_models: ['gpt-5.4', 'gpt-5.5'], preset_slug: 'support-bot', preset_version: null }] }); // UPDATE RETURNING
    mocks.resolvePreset.mockResolvedValueOnce(null); // preset deleted since mint → already orphaned
    const res = makeRes() as { writeHead: (c: number) => void; end: (b: string) => void; state: { statusCode: number; body: string } };

    await handleUpdateKey(makeReq({ allowed_models: ['gpt-5.4', 'gpt-5.5'] }), res, 'key_1');

    expect(res.state.statusCode).toBe(200);
  });
});
