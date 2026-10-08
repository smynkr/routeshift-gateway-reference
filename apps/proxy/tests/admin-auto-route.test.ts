/**
 * Admin auto-route settings PUT: max_fallbacks must be a true integer
 * (pg would 500 on a fractional/NaN bind) and invalid inputs fall back to
 * the default 2 — never floor to 0 (which would silently disable fallbacks).
 * quality_derank accepts only literal booleans; anything else preserves.
 */
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { handleUpdateAutoRouteSettings } from '../src/admin/auto-route.js';

function makeReq(body: unknown) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: '/admin/auto-route?team_id=team_1',
    headers: { host: 'localhost' },
  }) as never;
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
  // upsert + the post-write effective-flag read
  mocks.query.mockResolvedValue({ rows: [{ quality_derank: false }] });
});

describe('handleUpdateAutoRouteSettings input validation', () => {
  it('clamps integer max_fallbacks into [0, 5]', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handleUpdateAutoRouteSettings(makeReq({ max_fallbacks: 7 }), res);
    expect(res.state.statusCode).toBe(200);
    expect(JSON.parse(res.state.body).max_fallbacks).toBe(5);
  });

  it('falls back to the default (2) for fractional or NaN max_fallbacks — never floors to 0', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handleUpdateAutoRouteSettings(makeReq({ max_fallbacks: 0.9 }), res);
    expect(res.state.statusCode).toBe(200);
    expect(JSON.parse(res.state.body).max_fallbacks).toBe(2);
    // the SQL bind must be a true integer
    const params = mocks.query.mock.calls[0][1] as unknown[];
    expect(params[3]).toBe(2);
    expect(Number.isInteger(params[3])).toBe(true);
  });

  it('rejects non-numeric JSON (true/false/string) for max_fallbacks — false must not become 0', async () => {
    for (const junk of [false, true, '5', null]) {
      mocks.query.mockResolvedValueOnce({ rows: [] });
      const res = makeRes() as { state: { statusCode: number; body: string } };
      await handleUpdateAutoRouteSettings(makeReq({ max_fallbacks: junk }), res);
      expect(res.state.statusCode).toBe(200);
      expect(JSON.parse(res.state.body).max_fallbacks).toBe(2);
    }
  });

  it('preserves quality_derank on non-boolean junk instead of disabling the opt-in', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const res = makeRes() as { state: { statusCode: number; body: string } };
    await handleUpdateAutoRouteSettings(makeReq({ quality_derank: 'false' }), res);
    expect(res.state.statusCode).toBe(200);
    const params = mocks.query.mock.calls[0][1] as unknown[];
    expect(params[4]).toBeNull(); // COALESCE preserves the stored flag
  });
});
