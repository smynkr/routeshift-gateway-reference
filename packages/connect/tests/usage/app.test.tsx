import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { UsageApp } from '../../src/usage/app';
import type { UsageSummary } from '../../src/usage/client';

const DATA: UsageSummary = {
  range: { since: '2026-05-02T00:00:00.000Z', until: '2026-06-01T00:00:00.000Z', bucket: 'day' },
  summary: { requests: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, spend_microcents: 742_000_000, savings_microcents: 0, credit_balance_microcents: null },
  by_model: [{ model: 'gpt-4.1', provider: 'openai', requests: 1, input_tokens: 1, output_tokens: 1, spend_microcents: 1, savings_microcents: 0 }],
  by_key: [{ api_key_id: 'key_1', key_prefix: 'sk-proxy-live_acme', requests: 1, spend_microcents: 1, savings_microcents: 0 }],
  series: [{ bucket_start: '2026-05-31T00:00:00.000Z', spend_microcents: 742_000_000, input_tokens: 1, output_tokens: 1, requests: 1 }],
  contributions: [{ date: '2026-06-01', spend_microcents: 742_000_000, tokens: 2, level: 4 }],
};

function noopFetch(): typeof fetch {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: DATA }) })) as unknown as typeof fetch;
}

describe('UsageApp', () => {
  it('renders the one-shot dashboard from the initial payload', () => {
    const { lastFrame } = render(
      <UsageApp initial={DATA} baseUrl="https://api.routeshift.io" token="x" query={{}} graph="2d" watch={false} watchSeconds={5} fetchImpl={noopFetch()} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('$7.42');           // summary spend
    expect(out).toContain('gpt-4.1');         // default model breakdown
    expect(out).toContain('Contributions');   // 2D graph
  });

  it('renders the empty-period message when there is no usage', () => {
    const empty: UsageSummary = { ...DATA, summary: { ...DATA.summary, requests: 0, spend_microcents: 0 }, by_model: [], by_key: [], series: [], contributions: [] };
    const { lastFrame } = render(
      <UsageApp initial={empty} baseUrl="x" token="x" query={{}} graph="2d" watch={false} watchSeconds={5} fetchImpl={noopFetch()} />,
    );
    expect(lastFrame() ?? '').toContain('No usage in this period yet.');
  });
});
