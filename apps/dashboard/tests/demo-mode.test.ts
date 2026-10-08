import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted handle so the next/headers mock factory (runs before the file body)
// can reach the per-test cookie value.
const h = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'rs_demo' && h.cookieValue !== undefined ? { value: h.cookieValue } : undefined,
  }),
}));

import { getDemoProvenance, getEffectiveTeamId, isDemoModeEnabled, DEMO_TEAM_ID, DEMO_COOKIE } from '@/lib/demo';

afterEach(() => {
  h.cookieValue = undefined;
  vi.unstubAllEnvs();
});

describe('isDemoModeEnabled (env gate)', () => {
  it('is true when DEMO_MODE_ENABLED=1', () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '1');
    expect(isDemoModeEnabled()).toBe(true);
  });

  it('is false when DEMO_MODE_ENABLED=0', () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '0');
    expect(isDemoModeEnabled()).toBe(false);
  });

  it('is false in production without explicit opt-in', () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(isDemoModeEnabled()).toBe(false);
  });

  it('explicit opt-in overrides production NODE_ENV', () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '1');
    vi.stubEnv('NODE_ENV', 'production');
    expect(isDemoModeEnabled()).toBe(true);
  });

  it('is true in non-production without explicit opt-in', () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '');
    vi.stubEnv('NODE_ENV', 'development');
    expect(isDemoModeEnabled()).toBe(true);
  });
});

describe('getDemoProvenance', () => {
  it('SAFETY: returns inactive provenance when gate is disabled even if cookie is set', async () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '0');
    h.cookieValue = '1';

    await expect(getDemoProvenance()).resolves.toEqual({ active: false });
  });

  it('exposes explicit sample-data metadata only when demo mode is active', async () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '1');
    h.cookieValue = '1';

    const provenance = await getDemoProvenance();

    expect(provenance).toMatchObject({
      active: true,
      teamId: DEMO_TEAM_ID,
      label: 'Sample data',
    });
    expect(provenance.active).toBe(true);
    if (provenance.active !== true) throw new Error('expected active demo provenance');
    const activeProvenance = provenance as Extract<typeof provenance, { active: true }>;
    expect(activeProvenance.description).toContain('generated RouteShift demo reads');
    expect(activeProvenance.description).toContain('seeded demo team only');
    expect(activeProvenance.description).toContain('Writes and payments remain permission-gated to your workspace');
    expect(activeProvenance.description).not.toContain('customer');
    expect(activeProvenance.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns inactive provenance when the demo cookie is absent', async () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '1');
    h.cookieValue = undefined;

    await expect(getDemoProvenance()).resolves.toEqual({ active: false });
  });
});

describe('getEffectiveTeamId', () => {
  it('SAFETY: returns the real team when the gate is disabled, even if the demo cookie is set (no bypass)', async () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '0');
    h.cookieValue = '1';
    expect(await getEffectiveTeamId('real-team-123')).toBe('real-team-123');
  });

  it('returns the demo team when the gate is enabled and the cookie is set', async () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '1');
    h.cookieValue = '1';
    expect(await getEffectiveTeamId('real-team-123')).toBe(DEMO_TEAM_ID);
  });

  it('returns the real team when the gate is enabled but the cookie is absent', async () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '1');
    h.cookieValue = undefined;
    expect(await getEffectiveTeamId('real-team-123')).toBe('real-team-123');
  });

  it('ignores a cookie value other than "1"', async () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '1');
    h.cookieValue = '0';
    expect(await getEffectiveTeamId('real-team-123')).toBe('real-team-123');
  });

  it('returns null when there is no real team and demo is inactive', async () => {
    vi.stubEnv('DEMO_MODE_ENABLED', '1');
    h.cookieValue = undefined;
    expect(await getEffectiveTeamId(null)).toBeNull();
  });

  it('exposes the cookie name as a constant', () => {
    expect(DEMO_COOKIE).toBe('rs_demo');
  });
});
