import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUsableLabels = vi.fn();

vi.mock('../src/billing/provider-key-crypto.js', () => ({
  getUsableProviderKeyLabels: (...args: unknown[]) => mockUsableLabels(...args),
}));

import { getAutoRouteProviderSignals } from '../src/routing/auto-route-availability.js';
import { _resetKeyStats, recordLatency } from '../src/billing/key-stats.js';

beforeEach(() => {
  mockUsableLabels.mockReset();
  mockUsableLabels.mockResolvedValue([]);
  _resetKeyStats();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.TOGETHER_API_KEY;
  delete process.env.GROQ_API_KEY;
});

describe('getAutoRouteProviderSignals', () => {
  it('marks subscription providers available only from team keys', async () => {
    mockUsableLabels.mockImplementation(async (_teamId: string, provider: string) => (
      provider === 'openai' ? ['primary'] : []
    ));
    process.env.GOOGLE_API_KEY = 'google-platform';

    const signals = await getAutoRouteProviderSignals('team_1', 'subscription');
    const byProvider = new Map(signals.map((signal) => [signal.provider, signal]));

    expect(byProvider.get('openai')).toMatchObject({ credential_available: true });
    expect(byProvider.get('google')).toMatchObject({
      credential_available: false,
      unavailable_reason: 'missing_subscription_provider_key',
    });
    expect(byProvider.get('anthropic')).toMatchObject({
      credential_available: false,
      unavailable_reason: 'missing_subscription_provider_key',
    });
  });

  it('marks credits providers available only from platform keys', async () => {
    process.env.GOOGLE_API_KEY = 'google-platform';

    const signals = await getAutoRouteProviderSignals('team_1', 'credits');
    const byProvider = new Map(signals.map((signal) => [signal.provider, signal]));

    expect(mockUsableLabels).not.toHaveBeenCalled();
    expect(byProvider.get('google')).toMatchObject({ credential_available: true });
    expect(byProvider.get('openai')).toMatchObject({
      credential_available: false,
      unavailable_reason: 'missing_platform_provider_key_for_credits_billing',
    });
  });

  it('does not treat team keys as available for credits billing', async () => {
    const signals = await getAutoRouteProviderSignals('team_1', 'credits');
    const openai = signals.find((signal) => signal.provider === 'openai');

    expect(mockUsableLabels).not.toHaveBeenCalled();
    expect(openai).toMatchObject({
      credential_available: false,
      unavailable_reason: 'missing_platform_provider_key_for_credits_billing',
    });
  });

  it('includes warm measured p95 latency for available provider credentials', async () => {
    mockUsableLabels.mockImplementation(async (_teamId: string, provider: string) => (
      provider === 'openai' ? ['primary'] : []
    ));
    for (let i = 0; i < 12; i++) recordLatency('team_1', 'openai', 'primary', 100 + i);

    const signals = await getAutoRouteProviderSignals('team_1', 'subscription');
    const openai = signals.find((signal) => signal.provider === 'openai');

    expect(openai?.credential_available).toBe(true);
    expect(openai?.latency_sample_count).toBe(12);
    expect(openai?.latency_p95_ms).toBeGreaterThanOrEqual(100);
  });
});
