import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Summary } from '../../src/usage/Summary';
import { UsageApp } from '../../src/usage/app';
import { Sparkline } from '../../src/usage/Sparkline';
import { BreakdownTable } from '../../src/usage/BreakdownTable';
import { ContributionGraph } from '../../src/usage/ContributionGraph';
import type { UsageSummary } from '../../src/usage/client';

const FIXTURE: UsageSummary = {
  range: { since: '2026-05-02T00:00:00.000Z', until: '2026-06-01T00:00:00.000Z', bucket: 'day' },
  summary: { requests: 12840, input_tokens: 18_450_000, output_tokens: 5_120_000, cache_read_tokens: 9_200_000, cache_write_tokens: 410_000, spend_microcents: 742_000_000, savings_microcents: 268_000_000, credit_balance_microcents: 1_250_000_000 },
  by_model: [{ model: 'claude-opus-4-8', provider: 'anthropic', requests: 5120, input_tokens: 8_000_000, output_tokens: 2_000_000, spend_microcents: 500_000_000, savings_microcents: 200_000_000 }],
  by_key: [{ api_key_id: 'key_1', key_prefix: 'sk-proxy-live_acme', requests: 5120, spend_microcents: 500_000_000, savings_microcents: 200_000_000 }],
  series: [{ bucket_start: '2026-05-31T00:00:00.000Z', spend_microcents: 742_000_000, input_tokens: 1, output_tokens: 1, requests: 12840 }],
  contributions: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.UTC(2026, 4, 19 + i)).toISOString().slice(0, 10), spend_microcents: i * 1000, tokens: i, level: (i % 5) as 0 | 1 | 2 | 3 | 4 })),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Summary', () => {
  it('renders headline spend, savings, and credit balance', () => {
    const { lastFrame } = render(<Summary data={FIXTURE} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('$7.42');     // spend
    expect(out).toContain('$2.68');     // savings
    expect(out).toContain('$12.50');    // credit balance
    expect(out).toContain('18.5M');     // input tokens humanized
  });
});

describe('Sparkline', () => {
  it('downsamples large series to the available width', () => {
    const data = {
      ...FIXTURE,
      series: Array.from({ length: 500 }, (_, i) => ({
        bucket_start: new Date(Date.UTC(2026, 4, 1, i)).toISOString(),
        spend_microcents: i,
        input_tokens: 1,
        output_tokens: 1,
        requests: 1,
      })),
    };
    const { lastFrame } = render(<Sparkline data={data} width={40} />);
    const glyphs = (lastFrame() ?? '').match(/[▁▂▃▄▅▆▇█]/g) ?? [];
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs.length).toBeLessThanOrEqual(40);
  });
});

describe('BreakdownTable', () => {
  it('renders model rows by default and key rows when focus="key"', () => {
    const byModel = render(<BreakdownTable data={FIXTURE} focus="model" />);
    expect(byModel.lastFrame() ?? '').toContain('claude-opus-4-8');
    const byKey = render(<BreakdownTable data={FIXTURE} focus="key" />);
    expect(byKey.lastFrame() ?? '').toContain('sk-proxy-live_acme');
  });
  it('renders large spend values without truncation', () => {
    const data = {
      ...FIXTURE,
      by_model: [{
        ...FIXTURE.by_model[0],
        spend_microcents: 1_234_567_890_000_000,
      }],
      by_key: [{
        ...FIXTURE.by_key[0],
        spend_microcents: 1_234_567_890_000_000,
      }],
    };
    expect(render(<BreakdownTable data={data} focus="model" />).lastFrame() ?? '').toContain('$12,345,678.90');
    expect(render(<BreakdownTable data={data} focus="key" />).lastFrame() ?? '').toContain('$12,345,678.90');
  });
});

describe('UsageApp watch loop', () => {
  it('does not start a new refresh while the previous refresh is still in flight', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: Response) => void> = [];
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    })) as unknown as typeof fetch;
    const { unmount } = render(
      <UsageApp initial={FIXTURE} baseUrl="https://api.routeshift.io" token="x" query={{}} graph="2d" watch={true} watchSeconds={1} fetchImpl={fetchImpl} />,
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    unmount();
    resolvers[0]?.(usageResponse(FIXTURE));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('ContributionGraph', () => {
  it('2D: renders the legend and the contribution glyphs', () => {
    const { lastFrame } = render(<ContributionGraph data={FIXTURE} mode="2d" color={false} width={120} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('less');
    expect(out).toContain('more');
    expect(out).toMatch(/[·░▒▓█]/);
  });
  it('3D: renders without throwing and notes truncation on a narrow terminal', () => {
    // A full year (~53 weeks) cannot fit in 20 columns, so the 3D view must
    // render the most-recent weeks that fit and note the truncation.
    const yearData = {
      ...FIXTURE,
      contributions: Array.from({ length: 371 }, (_, i) => ({
        date: new Date(Date.UTC(2025, 5, 2 + i)).toISOString().slice(0, 10),
        spend_microcents: i * 100,
        tokens: i,
        level: (i % 5) as 0 | 1 | 2 | 3 | 4,
      })),
    };
    const { lastFrame } = render(<ContributionGraph data={yearData} mode="3d" color={false} width={20} />);
    const out = lastFrame() ?? '';
    expect(out.length).toBeGreaterThan(0);
    expect(out).toMatch(/showing last \d+ weeks/);
  });
});

function usageResponse(data: UsageSummary): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data }),
  } as Response;
}
