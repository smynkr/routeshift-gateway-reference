// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityLog } from '@/lib/activity-log';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

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
  plugin_warnings: [],
  status_code: 200,
  error_type: null,
  cache_hit: false,
  activity_category: 'coding',
  session_id: 'sess_1',
  api_key_id: 'key_1',
};

afterEach(() => {
  cleanup();
});

describe('generation route timeline', () => {
  it('traces requested → policy → resolved with the fallback path named', () => {
    render(<GenerationDetail log={fixture} />);

    expect(screen.getByText('Requested gpt-5.5-pro')).toBeTruthy();
    expect(screen.getByText('Resolved gpt-5.5')).toBeTruthy();
    expect(screen.getByText('Fallback path engaged')).toBeTruthy();
    expect(screen.getByText('1 fallback attempt recorded — exact reasons preserved below.')).toBeTruthy();
  });

  it('marks the resolved step failed without duplicating detail-row values', () => {
    render(<GenerationDetail log={{ ...fixture, status_code: 429 }} />);

    const resolved = screen.getByText('Resolved gpt-5.5');
    expect(resolved.className).toContain('text-red-300');
    expect(resolved.closest('li')?.className).toContain('border-red-500/20');
  });

  it('names a direct route and keeps the verbatim-reason pointer', () => {
    render(
      <GenerationDetail
        log={{ ...fixture, is_fallback: false, model_resolved: 'gpt-5.5-pro', fallback_attempts: [] }}
      />,
    );

    expect(screen.getByText('Served directly')).toBeTruthy();
    expect(screen.getByText('Exact route reasons preserved below.')).toBeTruthy();
  });

  it('surfaces the exact outcome error without collapsing it', () => {
    render(<GenerationDetail log={{ ...fixture, error_type: 'budget_exceeded' }} />);

    expect(screen.getByText('Outcome: budget_exceeded — full detail preserved below.')).toBeTruthy();
  });
});
