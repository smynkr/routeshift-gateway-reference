// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

import { AnalyticsClient } from '@/app/(dashboard)/analytics/analytics-client';

const ANALYTICS_RANGES = {
  '24h': {
    from: '2026-08-25T12:00:00.000Z',
    to: '2026-08-26T12:00:00.000Z',
  },
  '7d': {
    from: '2026-08-19T12:00:00.000Z',
    to: '2026-08-26T12:00:00.000Z',
  },
  '30d': {
    from: '2026-07-27T12:00:00.000Z',
    to: '2026-08-26T12:00:00.000Z',
  },
} as const;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const analyticsFixture = {
  range: ANALYTICS_RANGES['7d'],
  cost_by_model: [{
    model: 'gpt-5.4',
    provider: 'openai',
    requests: 12,
    total_cost: 1_250_000,
    total_billed_cost: 1_500_000,
    total_savings: 250_000,
    avg_latency_ms: 120,
    total_tokens: 4_000,
    unknown_cost_requests: 0,
    actual_costs_qualified: true,
  }],
  provider_comparison: [{
    provider: 'openai',
    requests: 12,
    total_cost: 1_250_000,
    total_billed_cost: 1_500_000,
    total_savings: 250_000,
    avg_latency_ms: 120,
    p95_latency_ms: 200,
    error_rate: 1 / 12,
    cache_hits: 2,
    unknown_cost_requests: 0,
    actual_costs_qualified: true,
  }],
  daily_trend: [],
  errors: [{
    provider: 'openai',
    status_code: 500,
    error_type: 'upstream_error',
    count: 1,
  }],
  cache: { total: 12, hits: 2, savings: 10_000 },
  reasoning_by_model: [],
};

const oneShotFixture = {
  summary: { sessions: 0, edit_turns: 0, retry_turns: 0, one_shot_rate: null },
  by_model: [],
};

const tokenHygieneFixture = {
  summary: {
    identity_count: 0,
    average_score: null,
    lowest_score: null,
    total_estimated_waste_microcents: 0,
  },
  records: [],
};

function seedFetch() {
  h.fetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/metrics/analytics')) {
      const requestedPeriod = new URL(url, 'https://app.test').searchParams.get('period') ?? '7d';
      const range = requestedPeriod in ANALYTICS_RANGES
        ? ANALYTICS_RANGES[requestedPeriod as keyof typeof ANALYTICS_RANGES]
        : ANALYTICS_RANGES['7d'];
      return Promise.resolve(jsonResponse({ ...analyticsFixture, range }));
    }
    if (url.includes('/api/usage/one-shot')) return Promise.resolve(jsonResponse(oneShotFixture));
    if (url.includes('/api/usage/token-hygiene')) return Promise.resolve(jsonResponse(tokenHygieneFixture));
    return Promise.resolve(jsonResponse({ error: 'unexpected request' }, 404));
  });
}

beforeEach(() => {
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Analytics evidence drill-through', () => {
  it('links provider, exact resolved model, and error evidence to the API-returned activity range', async () => {
    seedFetch();

    render(<AnalyticsClient />);

    const providerLink = await screen.findByRole('link', { name: 'View OpenAI requests' });
    expect(providerLink.getAttribute('href')).toBe(
      '/activity?provider=openai&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
    );
    expect(screen.getByRole('link', { name: 'View gpt-5.4 requests on OpenAI' }).getAttribute('href')).toBe(
      '/activity?provider=openai&resolved_model=gpt-5.4&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
    );
    expect(screen.getByRole('link', { name: 'View OpenAI errors' }).getAttribute('href')).toBe(
      '/activity?provider=openai&status=error&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
    );
    expect(screen.getByRole('group', { name: 'Model request evidence' })).toBeDefined();
  });

  it('distinguishes duplicate model evidence by provider and keeps rows narrow-safe', async () => {
    h.fetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/metrics/analytics')) {
        return Promise.resolve(jsonResponse({
          ...analyticsFixture,
          cost_by_model: [
            analyticsFixture.cost_by_model[0],
            { ...analyticsFixture.cost_by_model[0], provider: 'anthropic' },
          ],
          provider_comparison: [
            analyticsFixture.provider_comparison[0],
            { ...analyticsFixture.provider_comparison[0], provider: 'anthropic' },
          ],
        }));
      }
      if (url.includes('/api/usage/one-shot')) return Promise.resolve(jsonResponse(oneShotFixture));
      if (url.includes('/api/usage/token-hygiene')) return Promise.resolve(jsonResponse(tokenHygieneFixture));
      return Promise.resolve(jsonResponse({ error: 'unexpected request' }, 404));
    });

    render(<AnalyticsClient />);

    const group = await screen.findByRole('group', { name: 'Model request evidence' });
    expect(screen.getByRole('link', { name: 'View gpt-5.4 requests on OpenAI' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'View gpt-5.4 requests on Anthropic' })).toBeDefined();
    expect(group.querySelector('.min-w-0.truncate')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'View gpt-5.4 requests on OpenAI' }).className).toContain('shrink-0');
  });

  it('suppresses links when analytics rows have invalid resolved models', async () => {
    h.fetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/metrics/analytics')) {
        return Promise.resolve(jsonResponse({
          ...analyticsFixture,
          cost_by_model: [
            { ...analyticsFixture.cost_by_model[0], model: ' ' },
            { ...analyticsFixture.cost_by_model[0], model: 'x'.repeat(201) },
          ],
          provider_comparison: [],
          errors: [],
        }));
      }
      if (url.includes('/api/usage/one-shot')) return Promise.resolve(jsonResponse(oneShotFixture));
      if (url.includes('/api/usage/token-hygiene')) return Promise.resolve(jsonResponse(tokenHygieneFixture));
      return Promise.resolve(jsonResponse({ error: 'unexpected request' }, 404));
    });

    render(<AnalyticsClient />);

    await waitFor(() => expect(screen.getAllByText('Filter unavailable')).toHaveLength(2));
    expect(screen.queryByRole('link', { name: /requests on OpenAI/ })).toBeNull();
  });

  it('uses each newly returned range and hides stale evidence links during a period refresh', async () => {
    let resolveNextAnalytics!: (response: Response) => void;
    h.fetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/metrics/analytics')) {
        const requestedPeriod = new URL(url, 'https://app.test').searchParams.get('period') ?? '7d';
        if (requestedPeriod === '24h') {
          const { promise, resolve } = Promise.withResolvers<Response>();
          resolveNextAnalytics = resolve;
          return promise;
        }
        const range = requestedPeriod in ANALYTICS_RANGES
          ? ANALYTICS_RANGES[requestedPeriod as keyof typeof ANALYTICS_RANGES]
          : ANALYTICS_RANGES['7d'];
        return Promise.resolve(jsonResponse({ ...analyticsFixture, range }));
      }
      if (url.includes('/api/usage/one-shot')) return Promise.resolve(jsonResponse(oneShotFixture));
      if (url.includes('/api/usage/token-hygiene')) return Promise.resolve(jsonResponse(tokenHygieneFixture));
      return Promise.resolve(jsonResponse({ error: 'unexpected request' }, 404));
    });

    render(<AnalyticsClient />);
    await screen.findByRole('link', { name: 'View OpenAI requests' });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '24h' } });
    expect(screen.queryByRole('link', { name: 'View OpenAI requests' })).toBeNull();

    await waitFor(() => expect(resolveNextAnalytics).toBeTypeOf('function'));
    resolveNextAnalytics(jsonResponse({ ...analyticsFixture, range: ANALYTICS_RANGES['24h'] }));
    await waitFor(() => expect(screen.getByRole('link', { name: 'View OpenAI requests' }).getAttribute('href')).toBe(
      '/activity?provider=openai&from=2026-08-25T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
    ));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '30d' } });
    await waitFor(() => expect(screen.getByRole('link', { name: 'View OpenAI requests' }).getAttribute('href')).toBe(
      '/activity?provider=openai&from=2026-07-27T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
    ));
  });

  it('suppresses drill-through for providers outside the shared provider allowlist', async () => {
    h.fetch.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/metrics/analytics')) {
        return Promise.resolve(jsonResponse({
          ...analyticsFixture,
          cost_by_model: [{ ...analyticsFixture.cost_by_model[0], provider: 'future-provider' }],
          provider_comparison: [{ ...analyticsFixture.provider_comparison[0], provider: 'future-provider' }],
          errors: [{ ...analyticsFixture.errors[0], provider: 'future-provider' }],
        }));
      }
      if (url.includes('/api/usage/one-shot')) return Promise.resolve(jsonResponse(oneShotFixture));
      if (url.includes('/api/usage/token-hygiene')) return Promise.resolve(jsonResponse(tokenHygieneFixture));
      return Promise.resolve(jsonResponse({ error: 'unexpected request' }, 404));
    });

    render(<AnalyticsClient />);

    await waitFor(() => expect(screen.getAllByText('Filter unavailable')).toHaveLength(3));
    expect(screen.queryByRole('link', { name: 'View gpt-5.4 requests' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'View future-provider requests' })).toBeNull();
  });
});
