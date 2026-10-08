// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { AnalyticsClient } from '@/app/(dashboard)/analytics/analytics-client';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseAnalytics = {
  cost_by_model: [],
  provider_comparison: [],
  daily_trend: [],
  errors: [],
  cache: { total: 0, hits: 0, savings: 0 },
};

const emptyOneShot = {
  summary: { sessions: 0, edit_turns: 0, retry_turns: 0, one_shot_rate: null },
  by_model: [],
};

const emptyTokenHygiene = {
  summary: {
    identity_count: 0,
    average_score: null,
    lowest_score: null,
    total_estimated_waste_microcents: 0,
  },
  records: [],
};

function seedFetch(reasoningByModel: Array<Record<string, unknown>>) {
  h.fetch.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/metrics/analytics')) {
      return Promise.resolve(jsonResponse({ ...baseAnalytics, reasoning_by_model: reasoningByModel }));
    }
    if (url.includes('/api/usage/one-shot')) return Promise.resolve(jsonResponse(emptyOneShot));
    if (url.includes('/api/usage/token-hygiene')) return Promise.resolve(jsonResponse(emptyTokenHygiene));
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

describe('AnalyticsClient reasoning breakdown', () => {
  it('renders populated reasoning usage with truthful counts, share, cost, and explanatory copy', async () => {
    seedFetch([
      {
        provider: 'openai',
        model: 'o1-mini',
        requests: 4,
        reasoning_token_requests: 2,
        reasoning_tokens: 100,
        output_tokens: 400,
        reasoning_output_share: 0.25,
        reasoning_cost_microcents: 125000,
        unknown_reasoning_cost_requests: 0,
      },
      {
        provider: 'anthropic',
        model: 'claude-3-7-sonnet',
        requests: 1,
        reasoning_token_requests: 1,
        reasoning_tokens: 50,
        output_tokens: 100,
        reasoning_output_share: null,
        reasoning_cost_microcents: 25000,
        unknown_reasoning_cost_requests: 0,
      },
    ]);

    render(<AnalyticsClient />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reasoning usage by model' })).toBeTruthy());

    const table = screen.getByRole('table', { name: 'Reasoning usage by model' });
    const populatedRow = within(table).getByText('o1-mini').closest('tr');
    expect(populatedRow).not.toBeNull();
    const populatedCells = within(populatedRow as HTMLElement);
    expect(populatedCells.getByText('openai')).toBeTruthy();
    expect(populatedCells.getByText('o1-mini')).toBeTruthy();
    expect(populatedCells.getByText('4')).toBeTruthy();
    expect(populatedCells.getByText('2')).toBeTruthy();
    expect(populatedCells.getByText('100')).toBeTruthy();
    expect(populatedCells.getByText('400')).toBeTruthy();
    expect(populatedCells.getByText('25%')).toBeTruthy();
    expect(populatedCells.getByText('$0.0013')).toBeTruthy();
    expect(within(table).getByText('claude-3-7-sonnet')).toBeTruthy();
    expect(within(table).getByText('—')).toBeTruthy();
    expect(screen.getByText(/provider-reported reasoning tokens; inclusion in output tokens varies by provider/i)).toBeTruthy();
    expect(screen.getByText(/unavailable telemetry or cost is not treated as zero/i)).toBeTruthy();

  });

  it('marks partially known reasoning cost as a lower bound', async () => {
    seedFetch([{
      provider: 'openai',
      model: 'o1-mini',
      requests: 4,
      reasoning_token_requests: 3,
      reasoning_tokens: 100,
      output_tokens: 400,
      reasoning_output_share: 0.25,
      reasoning_cost_microcents: 125000,
      unknown_reasoning_cost_requests: 1,
    }]);

    render(<AnalyticsClient />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reasoning usage by model' })).toBeTruthy());
    const table = screen.getByRole('table', { name: 'Reasoning usage by model' });
    expect(within(table).getByText('≥ $0.0013')).toBeTruthy();
    expect(within(table).queryByText('$0.0013')).toBeNull();
  });

  it('does not render a reasoning table when every row is unreported', async () => {
    seedFetch([{
      provider: 'openai',
      model: 'o1-mini',
      requests: 4,
      reasoning_token_requests: 0,
      reasoning_tokens: 0,
      output_tokens: 400,
      reasoning_output_share: null,
      reasoning_cost_microcents: 0,
      unknown_reasoning_cost_requests: 0,
    }]);

    render(<AnalyticsClient />);

    await waitFor(() => expect(screen.getByText('Total Billed Spend')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Reasoning usage by model' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Reasoning usage by model' })).toBeNull();
  });

  it('shows an em dash when unknown reasoning cost requests have no exact reported cost', async () => {
    seedFetch([{
      provider: 'openai',
      model: 'o1-mini',
      requests: 4,
      reasoning_token_requests: 2,
      reasoning_tokens: 100,
      output_tokens: 400,
      reasoning_output_share: 0.25,
      reasoning_cost_microcents: null,
      unknown_reasoning_cost_requests: 1,
    }]);

    render(<AnalyticsClient />);

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Reasoning usage by model' })).toBeTruthy());

    const table = screen.getByRole('table', { name: 'Reasoning usage by model' });
    expect(within(table).getByText('—')).toBeTruthy();
    expect(within(table).queryByText('$0.0000')).toBeNull();
  });
});
