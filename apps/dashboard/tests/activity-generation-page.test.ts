import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: null as null | { userId: string; teamId: string; role: string },
  query: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: async () => h.member,
}));

vi.mock('@/lib/demo', () => ({
  getEffectiveTeamId: async () => 'effective_team',
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: h.query }),
}));

vi.mock('@/lib/login-redirect', () => ({
  redirectToLogin: (path: string) => ({ redirectTo: path }),
}));

vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

import ActivityGenerationPage from '@/app/(dashboard)/activity/[id]/page';

beforeEach(() => {
  h.member = { userId: 'user_1', teamId: 'real_team', role: 'member' };
  h.query.mockReset();
});

describe('activity generation detail page', () => {
  it('uses the effective team and not-found behavior for an absent generation', async () => {
    h.query.mockResolvedValueOnce({ rows: [] });

    await expect(ActivityGenerationPage({
      params: Promise.resolve({ id: 'req_missing' }),
    })).rejects.toThrow('NEXT_NOT_FOUND');

    expect(h.query.mock.calls[0]?.[1]).toEqual(['req_missing', 'effective_team']);
  });

  it('does not distinguish a cross-team identifier from a missing identifier', async () => {
    h.query.mockResolvedValueOnce({ rows: [] });
    const missing = ActivityGenerationPage({
      params: Promise.resolve({ id: 'req_missing' }),
    });

    h.query.mockResolvedValueOnce({ rows: [] });
    const crossTeam = ActivityGenerationPage({
      params: Promise.resolve({ id: 'req_from_other_team' }),
    });

    await expect(missing).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(crossTeam).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('redirects unauthenticated requests without querying the database', async () => {
    h.member = null;

    await expect(ActivityGenerationPage({
      params: Promise.resolve({ id: 'req/one' }),
    })).resolves.toEqual({ redirectTo: '/activity/req%2Fone' });

    expect(h.query).not.toHaveBeenCalled();
  });

  it('propagates database failures instead of converting them to not-found', async () => {
    h.query.mockRejectedValueOnce(new Error('db down'));

    await expect(ActivityGenerationPage({
      params: Promise.resolve({ id: 'req_1' }),
    })).rejects.toThrow('db down');
  });
});
