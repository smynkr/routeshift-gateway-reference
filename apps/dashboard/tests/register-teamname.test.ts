import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-60: register validated email/password/name but inserted teamName with no
// type/length check, and `teamName ?? default` let an empty string through as a
// blank team name.

const h = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    query: h.poolQuery,
    connect: async () => ({ query: h.clientQuery, release: h.release }),
  }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ allowed: true, remaining: 4, retryAfterSec: 0 }),
  getClientIp: () => '1.1.1.1',
  rateLimitedResponse: () => new Response(null, { status: 429 }),
}));

import { POST as registerPOST } from '@/app/api/auth/register/route';

function req(body: unknown) {
  return new Request('https://app.test/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://example';
  h.poolQuery.mockReset().mockResolvedValue({ rows: [] }); // email not taken
  h.clientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  h.release.mockReset();
});

const valid = { email: 'a@b.com', password: 'password1', name: 'Ada' };

describe('register teamName validation (RSH-60)', () => {
  it('rejects a non-string teamName with 400', async () => {
    const res = await registerPOST(req({ ...valid, teamName: 123 }));
    expect(res.status).toBe(400);
    expect(h.clientQuery).not.toHaveBeenCalled();
  });

  it('rejects an oversized teamName with 400', async () => {
    const res = await registerPOST(req({ ...valid, teamName: 'x'.repeat(256) }));
    expect(res.status).toBe(400);
  });

  it('falls back to the default name when teamName is empty/whitespace', async () => {
    await registerPOST(req({ ...valid, teamName: '   ' }));
    const teamsInsert = h.clientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO teams'));
    expect(teamsInsert![1][1]).toBe("Ada's Team");
  });

  it('uses a provided valid teamName (trimmed)', async () => {
    await registerPOST(req({ ...valid, teamName: '  Acme  ' }));
    const teamsInsert = h.clientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO teams'));
    expect(teamsInsert![1][1]).toBe('Acme');
  });
});
