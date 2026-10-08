import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRateLimit, __resetRateLimitStore } from '@/lib/rate-limit';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' },
  demoActive: false,
  fetch: vi.fn(),
  getModelPricing: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: async () => h.member,
}));

vi.mock('@/lib/demo', () => ({
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only.',
  isDemoActive: async () => h.demoActive,
}));

vi.mock('@routeshift/shared', () => ({
  getModelPricing: h.getModelPricing,
}));

import { POST } from '@/app/api/optimize/prompt/route';

const RATE_LIMIT_BODY = {
  error: 'rate_limited',
  error_description: 'Too many requests. Please slow down and retry.',
};

function setTeam(teamId: string): void {
  h.member.teamId = teamId;
}

function jsonReq(body: unknown): Request {
  return new Request('https://app.test/api/optimize/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function rawReq(body: string): Request {
  return new Request('https://app.test/api/optimize/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

async function consumeDailyQuota(teamId: string): Promise<void> {
  setTeam(teamId);
  for (let i = 0; i < 200; i += 1) {
    const res = await POST(jsonReq({ prompt: `Optimize prompt ${i}`, mode: 'compress' }));
    if (res.status !== 200) {
      throw new Error(`expected quota-fill request ${i + 1} to succeed, got ${res.status}`);
    }
    vi.advanceTimersByTime(60_001);
  }
}

describe('optimize prompt route rate limits', () => {
  beforeEach(() => {
    __resetRateLimitStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T12:00:00Z'));
    setTeam('team_1');
    h.demoActive = false;
    h.getModelPricing.mockReset();
    h.getModelPricing.mockReturnValue({ input_per_million: 3 });
    h.fetch.mockReset();
    h.fetch.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Optimized prompt' }],
          usage: { input_tokens: 240, output_tokens: 80 },
          model: 'claude-sonnet-4-5-20250929',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
    vi.stubEnv('OPTIMIZER_PROVIDER', 'anthropic');
    vi.stubEnv('OPTIMIZER_ANTHROPIC_KEY', 'test-anthropic-key');
    vi.stubEnv('OPTIMIZER_MODEL', 'claude-sonnet-4-5-20250929');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('rejects the 201st same-team call via the 24h daily limiter, not the minute limiter', async () => {
    await consumeDailyQuota('team_daily');
    h.fetch.mockClear();

    const blocked = await POST(rawReq('{not-json'));

    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual(RATE_LIMIT_BODY);
    expect(blocked.headers.get('Cache-Control')).toBe('no-store');
    expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(60 * 60);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(
      checkRateLimit('optimize-prompt:team_daily', { limit: 20, windowMs: 60_000 }).allowed,
    ).toBe(true);
  });

  it('lets a fresh team under the daily cap run normally', async () => {
    setTeam('team_fresh');

    const res = await POST(jsonReq({ prompt: 'Optimize this prompt', mode: 'clarify' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      optimized: 'Optimized prompt',
      backend: 'anthropic',
      modelUsed: 'claude-sonnet-4-5-20250929',
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps daily buckets independent across teams', async () => {
    await consumeDailyQuota('team_a');
    const blocked = await POST(jsonReq({ prompt: 'Team A over cap', mode: 'both' }));
    expect(blocked.status).toBe(429);

    h.fetch.mockClear();
    setTeam('team_b');
    const res = await POST(jsonReq({ prompt: 'Team B still has quota', mode: 'both' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ optimized: 'Optimized prompt', backend: 'anthropic' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
