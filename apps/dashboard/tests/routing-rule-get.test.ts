import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  demoActive: vi.fn(async () => false),
  requireMembership: vi.fn(async () => ({ teamId: 'team-1', role: 'admin' })),
  requireRole: vi.fn(async () => ({ teamId: 'team-1', role: 'admin' })),
  poolQuery: vi.fn(),
}));

vi.mock('@/lib/demo', () => ({
  isDemoActive: h.demoActive,
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only.',
}));
vi.mock('@/lib/demo-constants', () => ({ DEMO_TEAM_ID: 'demo-team' }));
vi.mock('@/lib/rbac', () => ({
  requireRole: h.requireRole,
  requireTeamMembership: h.requireMembership,
}));
vi.mock('@/lib/proxy', () => ({
  PROXY_URL: 'http://proxy.test',
  adminHeaders: () => ({ Authorization: 'Bearer secret' }),
  assertAdminSecret: () => {},
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.poolQuery }) }));

const { GET } = await import('@/app/api/rules/[id]/route');

beforeEach(() => {
  h.fetchMock.mockReset();
  h.poolQuery.mockReset();
  h.demoActive.mockResolvedValue(false);
  h.requireMembership.mockResolvedValue({ teamId: 'team-1', role: 'admin' });
  global.fetch = h.fetchMock;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/rules/[id]', () => {
  it('forbids non-admin reads (the edit surface is admin-only)', async () => {
    h.requireRole.mockResolvedValueOnce(undefined as unknown as { teamId: string; role: string });
    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'rule-9' }) });
    expect(res.status).toBe(403);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('returns the rule from the proxy list, team-scoped', async () => {
    const rule = { id: 'rule-9', team_id: 'team-1', name: 'Cheap route', priority: 500, condition: {}, action: { type: 'route', target_provider: 'openai' } };
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [rule] });

    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'rule-9' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rule);
    expect(h.fetchMock).toHaveBeenCalledWith('http://proxy.test/admin/rules?team_id=team-1', expect.anything());
  });

  it('404s when the id is not in the team list (no cross-team read)', async () => {
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [{ id: 'other-rule', team_id: 'team-1' }] });

    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'rule-9' }) });
    expect(res.status).toBe(404);
  });

  it('404s a cross-team rule even if the proxy list leaks one (defensive)', async () => {
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [{ id: 'rule-9', team_id: 'team-other' }] });

    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'rule-9' }) });
    expect(res.status).toBe(404);
  });

  it('allows global rules through (read-only by design)', async () => {
    const global = { id: 'rule-9', team_id: '*', name: 'Global' };
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => [global] });

    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'rule-9' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(global);
  });

  it('passes through the proxy list status on failure', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: { message: 'boom' } }) });

    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'rule-9' }) });
    expect(res.status).toBe(502);
  });

  it('reads the seeded row in demo mode', async () => {
    h.demoActive.mockResolvedValue(true);
    h.poolQuery.mockResolvedValue({ rows: [{ id: 'rule-9', name: 'Demo rule' }] });

    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'rule-9' }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'rule-9', name: 'Demo rule' });
    expect(h.poolQuery.mock.calls[0][1]).toEqual(['rule-9', 'demo-team']);
  });

  it('404s in demo mode when the seeded row is missing', async () => {
    h.demoActive.mockResolvedValue(true);
    h.poolQuery.mockResolvedValue({ rows: [] });

    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'nope' }) });
    expect(res.status).toBe(404);
  });
});
