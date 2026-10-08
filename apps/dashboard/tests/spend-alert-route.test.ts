import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: { teamId: 'team_effective', userId: 'user_1', role: 'admin' } as { teamId: string; userId: string; role: string } | null,
  requireRole: vi.fn(),
  isDemoActive: vi.fn(),
  getEffectiveTeamId: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({ requireRole: h.requireRole }));
vi.mock('@/lib/demo', () => ({
  isDemoActive: h.isDemoActive,
  getEffectiveTeamId: h.getEffectiveTeamId,
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only.',
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));


import { GET, PUT } from '@/app/api/alerts/spend/route';

beforeEach(() => {
  h.member = { teamId: 'team_effective', userId: 'user_1', role: 'admin' };
  h.requireRole.mockReset().mockResolvedValue(h.member);
  h.isDemoActive.mockReset().mockResolvedValue(false);
  h.getEffectiveTeamId.mockReset().mockResolvedValue(h.member.teamId);
  h.query.mockReset().mockResolvedValue({ rows: [] });
});

describe('spend alert settings route', () => {
  it('scopes reads to the membership-derived team and never exposes a signing secret', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ enabled: true, webhook_url: 'https://alerts.example.test/hook', threshold_multiplier: '3', baseline_days: '14' }] });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      webhook_url: 'https://alerts.example.test/hook',
      threshold_multiplier: 3,
      baseline_days: 14,
    });
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('WHERE team_id = $1'), ['team_effective']);
    expect(JSON.stringify(h.query.mock.calls)).not.toMatch(/secret/i);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reads the demo team config instead of live settings while demo mode is active', async () => {
    h.isDemoActive.mockResolvedValueOnce(true);
    h.getEffectiveTeamId.mockResolvedValueOnce('demo_team');
    h.query.mockResolvedValueOnce({
      rows: [{ enabled: false, webhook_url: '', threshold_multiplier: '2', baseline_days: '7' }],
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(h.getEffectiveTeamId).toHaveBeenCalledWith('team_effective');
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('WHERE team_id = $1'), ['demo_team']);
  });

  it('rejects invalid settings before writing', async () => {
    const response = await PUT(new Request('https://app.test/api/alerts/spend', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true, webhook_url: 'http://insecure.test/hook', threshold_multiplier: 2, baseline_days: 7 }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(400);
    expect(h.query).not.toHaveBeenCalled();
  });
  it('blocks writes while demo mode is active', async () => {
    h.isDemoActive.mockResolvedValueOnce(true);

    const response = await PUT(new Request('https://app.test/api/alerts/spend', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false, webhook_url: '', threshold_multiplier: 2, baseline_days: 7 }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Demo mode is read-only.' });
    expect(h.requireRole).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('writes only the effective team even when the body contains another team id', async () => {
    const response = await PUT(new Request('https://app.test/api/alerts/spend', {
      method: 'PUT',
      body: JSON.stringify({ team_id: 'attacker_team', enabled: true, webhook_url: 'https://alerts.example.test/hook', threshold_multiplier: 3, baseline_days: 14 }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.query.mock.calls[0]?.[1]).toEqual(['team_effective', true, 'https://alerts.example.test/hook', 3, 14]);
    expect(await response.json()).toMatchObject({ enabled: true, threshold_multiplier: 3, baseline_days: 14 });
  });
  it('writes to the effective team context', async () => {
    h.requireRole.mockResolvedValueOnce({ teamId: 'membership_team', userId: 'user_1', role: 'admin' });
    h.getEffectiveTeamId.mockResolvedValueOnce('workspace_team');

    const response = await PUT(new Request('https://app.test/api/alerts/spend', {
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        webhook_url: 'https://alerts.example.test/hook',
        threshold_multiplier: 2,
        baseline_days: 7,
      }),
      headers: { 'content-type': 'application/json' },
    }));

    expect(response.status).toBe(200);
    expect(h.query.mock.calls[0]?.[1]).toEqual(['workspace_team', true, 'https://alerts.example.test/hook', 2, 7]);
  });
});
