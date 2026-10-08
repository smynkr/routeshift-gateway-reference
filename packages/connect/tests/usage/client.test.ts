import { describe, expect, it, vi } from 'vitest';
import { fetchUsageSummary, ReconnectNeededError } from '../../src/usage/client';

const ENVELOPE = {
  data: {
    range: { since: '2026-05-02T00:00:00.000Z', until: '2026-06-01T00:00:00.000Z', bucket: 'day' },
    summary: { requests: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, spend_microcents: 100, savings_microcents: 0, credit_balance_microcents: null },
    by_model: [], by_key: [], series: [], contributions: [],
  },
};

describe('fetchUsageSummary', () => {
  it('GETs /v1/usage/summary with a Bearer token, forwards params, and unwraps .data', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ENVELOPE })) as unknown as typeof fetch;
    const result = await fetchUsageSummary('https://api.routeshift.io', 'sk-proxy-live_acme_x', { since: '30d', bucket: 'day', graph: '2d' }, fetchImpl);

    expect(result.summary.spend_microcents).toBe(100);
    const calledUrl = new URL((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/v1/usage/summary');
    expect(calledUrl.searchParams.get('since')).toBe('30d');
    expect(calledUrl.searchParams.get('bucket')).toBe('day');
    expect(calledUrl.searchParams.has('graph')).toBe(false); // graph is client-only
    const init = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-proxy-live_acme_x');
  });

  it('maps 401 to ReconnectNeededError', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchUsageSummary('https://api.routeshift.io', 'bad', {}, fetchImpl)).rejects.toBeInstanceOf(ReconnectNeededError);
  });

  it('preserves a path-prefixed baseUrl when building the summary URL', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ENVELOPE })) as unknown as typeof fetch;
    await fetchUsageSummary('https://host.example/api/', 'sk-proxy-live_acme_x', { since: '30d', until: 'today', bucket: 'day' }, fetchImpl);

    const calledUrl = new URL((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string);
    expect(calledUrl.origin).toBe('https://host.example');
    expect(calledUrl.pathname).toBe('/api/v1/usage/summary');
    expect(calledUrl.searchParams.get('since')).toBe('30d');
    expect(calledUrl.searchParams.get('until')).toBe('today');
    expect(calledUrl.searchParams.get('bucket')).toBe('day');
  });

  it('throws a generic error on 5xx', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchUsageSummary('https://api.routeshift.io', 'x', {}, fetchImpl)).rejects.toThrow(/503/);
  });
});
