import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-138: key create/update/list carry the three budget cap fields through
// the dashboard boundary, with no-store on the list GET.

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  body: {} as Record<string, unknown>,
}));

vi.mock('@/lib/rbac', () => ({
  requireRole: async () => ({ teamId: 'team_1', userId: 'u1', role: 'admin' }),
  requireTeamMembership: async () => ({ teamId: 'team_1' }),
}));
vi.mock('@/lib/demo', () => ({
  DEMO_WRITE_BLOCKED_MESSAGE: 'demo',
  isDemoActive: async () => false,
  getEffectiveTeamId: async (t: string) => t,
}));
vi.mock('@/lib/proxy', () => ({
  PROXY_URL: 'http://proxy.test',
  adminHeaders: () => ({ 'x-admin-secret': 's' }),
  assertAdminSecret: () => undefined,
}));
vi.mock('@/lib/request-json', () => ({ readJsonObject: async () => h.body }));

import { GET, POST } from '@/app/api/keys/route';
import { PATCH } from '@/app/api/keys/[id]/route';

beforeEach(() => {
  h.fetch.mockReset();
  h.fetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', h.fetch);
});

describe('key budget caps through the dashboard boundary (RSH-138)', () => {
  it('forwards all three cap fields on create', async () => {
    h.body = { name: 'caps', daily_usd_cap: 0.07, weekly_usd_cap: 8.29, monthly_usd_cap: 99.99 };
    await POST(new Request('https://app.test/api/keys', { method: 'POST' }));

    const forwarded = JSON.parse(h.fetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(forwarded.team_id).toBe('team_1');
    expect(forwarded.daily_usd_cap).toBe(0.07);
    expect(forwarded.weekly_usd_cap).toBe(8.29);
    expect(forwarded.monthly_usd_cap).toBe(99.99);
  });

  it('forwards explicit null clears on update', async () => {
    h.fetch.mockResolvedValue(
      new Response(JSON.stringify({ id: 'key_1', daily_usd_cap: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    await PATCH(
      new Request('https://app.test/api/keys/key_1', { method: 'PATCH', body: JSON.stringify({ daily_usd_cap: null }) }),
      { params: Promise.resolve({ id: 'key_1' }) },
    );

    const [url, init] = h.fetch.mock.calls[0]!;
    expect(String(url)).toContain('team_id=team_1');
    // LAY-331: the dashboard injects the authenticated user as the audit
    // actor on PATCH (proxy-side updated events record WHO changed the key).
    expect(JSON.parse(init!.body as string)).toEqual({ daily_usd_cap: null, actor_user_id: 'u1' });
  });

  it('marks the list GET no-store', async () => {
    const res = await GET();

    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('never lets a client-supplied team id override the session team', async () => {
    h.body = { name: 'evil', team_id: 'team_attacker' };
    await POST(new Request('https://app.test/api/keys', { method: 'POST' }));

    const forwarded = JSON.parse(h.fetch.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(forwarded.team_id).toBe('team_1');
  });
});
