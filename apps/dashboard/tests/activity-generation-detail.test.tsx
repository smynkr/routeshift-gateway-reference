// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityLog } from '@/lib/activity-log';
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { ActivityClient } from '@/app/(dashboard)/activity/activity-client';
import { GenerationDetail } from '@/app/(dashboard)/activity/[id]/generation-detail';

const fixture: ActivityLog = {
  id: 'req_1',
  timestamp: '2026-08-08T12:00:00.000Z',
  provider: 'openai',
  model_requested: 'gpt-5.5-pro',
  model_resolved: 'gpt-5.5',
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
  original_cost_microcents: 500,
  actual_cost_microcents: 300,
  actual_cost_known: false,
  plugin_cost_microcents: 20,
  billed_cost_microcents: 320,
  savings_microcents: 200,
  total_latency_ms: 180,
  ttft_ms: 70,
  is_streaming: true,
  is_fallback: true,
  fallback_attempts: [{ provider: 'anthropic', model: 'claude-sonnet-4-5', error: 'provider_timeout: upstream took 30s' }],
  plugin_warnings: [{ plugin: 'web', code: 'optional_plugin_skipped', reason: 'plugin_backend_unconfigured', message: 'No backend' }],
  status_code: 200,
  error_type: null,
  cache_hit: false,
  activity_category: 'coding',
  session_id: 'sess_1',
  api_key_id: 'key_1',
};

describe('generation detail view', () => {
  it('renders exact routing reasons and truthful unknown-cost labels', () => {
    render(<GenerationDetail log={fixture} />);

    expect(screen.getByRole('heading', { name: 'Generation details', level: 1 })).toBeTruthy();
    expect(screen.getByText('provider_timeout: upstream took 30s')).toBeTruthy();
    expect(screen.getByText('plugin_backend_unconfigured')).toBeTruthy();
    expect(screen.getAllByText('Observed lower bound: $0.0000').length).toBeGreaterThan(0);
    expect(screen.getByText('gpt-5.5')).toBeTruthy();
    expect(screen.getByText('openai')).toBeTruthy();
    expect(screen.getByText('Miss')).toBeTruthy();
    expect(screen.queryByText('Routing savings')).toBeNull();
    expect(screen.queryByText('cost unknown')).toBeNull();
    expect(screen.getByRole('link', { name: '← Activity' }).getAttribute('href')).toBe('/activity');
  });

  it('does not fabricate cache or timing facts for failed generations', () => {
    render(
      <GenerationDetail
        log={{
          ...fixture,
          status_code: 429,
          ttft_ms: null,
          fallback_attempts: [{ ...fixture.fallback_attempts[0]!, actual_cost_known: false }],
        }}
      />,
    );

    expect(screen.getByText('Not recorded')).toBeTruthy();
    expect(screen.queryByText('Miss')).toBeNull();
    expect(screen.queryByText('Time to first token')).toBeNull();
    expect(screen.getByText('cost unknown')).toBeTruthy();
    expect(screen.queryByText('Routing savings')).toBeNull();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('activity row generation deep-link', () => {
  it('links an expanded request to its generation detail page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ logs: [fixture], total: 1, page: 1, limit: 50, totalPages: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ActivityClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand request req_1' }));

    expect(screen.getByRole('link', { name: 'View generation details' }).getAttribute('href')).toBe('/activity/req_1');
  });

  it('URL-encodes an opaque request ID in the generation detail link', async () => {
    const encodedIdFixture = { ...fixture, id: 'req/one' };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ logs: [encodedIdFixture], total: 1, page: 1, limit: 50, totalPages: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ActivityClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand request req/one' }));

    expect(screen.getByRole('link', { name: 'View generation details' }).getAttribute('href')).toBe('/activity/req%2Fone');
  });
});
