import { describe, expect, it } from 'vitest';
import {
  resolveUsageRange,
  zeroFillSeries,
  buildContributions,
  levelFor,
} from '../src/usage/summary-range.js';

const NOW = new Date('2026-06-01T12:30:00.000Z');

function expectRange(params: URLSearchParams) {
  const result = resolveUsageRange(params, NOW);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.range;
}

function expectRangeError(params: URLSearchParams) {
  const result = resolveUsageRange(params, NOW);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected range validation to fail');
  expect(result.status).toBe(400);
  return result.message;
}

describe('resolveUsageRange', () => {
  it('defaults to 30d / day bucket / 365 contrib days', () => {
    const r = expectRange(new URLSearchParams());
    expect(r.until.toISOString()).toBe('2026-06-01T12:30:00.000Z');
    expect(r.since.toISOString()).toBe('2026-05-02T12:30:00.000Z');
    expect(r.bucket).toBe('day');
    expect(r.contribDays).toBe(365);
  });

  it('resolves "today" to the start of the UTC day', () => {
    const r = expectRange(new URLSearchParams({ since: 'today' }));
    expect(r.since.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('resolves 7d and 30d windows', () => {
    expect(expectRange(new URLSearchParams({ since: '7d' })).since.toISOString())
      .toBe('2026-05-25T12:30:00.000Z');
    expect(expectRange(new URLSearchParams({ since: '30d' })).since.toISOString())
      .toBe('2026-05-02T12:30:00.000Z');
  });

  it('resolves "month" to the start of the calendar month and "ytd" to Jan 1', () => {
    expect(expectRange(new URLSearchParams({ since: 'month' })).since.toISOString())
      .toBe('2026-06-01T00:00:00.000Z');
    expect(expectRange(new URLSearchParams({ since: 'ytd' })).since.toISOString())
      .toBe('2026-01-01T00:00:00.000Z');
  });

  it('accepts explicit ISO since/until', () => {
    const r = expectRange(
      new URLSearchParams({ since: '2026-04-01T00:00:00.000Z', until: '2026-04-08T00:00:00.000Z' }),
    );
    expect(r.since.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(r.until.toISOString()).toBe('2026-04-08T00:00:00.000Z');
  });

  it('honors bucket=hour and rejects junk by falling back to day', () => {
    expect(expectRange(new URLSearchParams({ bucket: 'hour' })).bucket).toBe('hour');
    expect(expectRange(new URLSearchParams({ bucket: 'nonsense' })).bucket).toBe('day');
  });

  it('clamps contrib_days to [1,371]', () => {
    expect(expectRange(new URLSearchParams({ contrib_days: '5000' })).contribDays).toBe(371);
    expect(expectRange(new URLSearchParams({ contrib_days: '0' })).contribDays).toBe(1);
    expect(expectRange(new URLSearchParams({ contrib_days: '90' })).contribDays).toBe(90);
  });

  it('returns a 400 result for invalid since/until params', () => {
    expect(expectRangeError(new URLSearchParams({ since: 'not-a-date' }))).toContain('since');
    expect(expectRangeError(new URLSearchParams({ since: '' }))).toContain('since');
    expect(expectRangeError(new URLSearchParams({ until: 'not-a-date' }))).toContain('until');
    expect(expectRangeError(new URLSearchParams({ until: '' }))).toContain('until');
  });

  it('returns a 400 result for reversed ranges', () => {
    expect(expectRangeError(new URLSearchParams({
      since: '2026-06-02T00:00:00.000Z',
      until: '2026-06-01T00:00:00.000Z',
    }))).toContain('since must be before until');
  });

  it('returns a 400 result when the hourly bucket window exceeds the cap', () => {
    expect(expectRangeError(new URLSearchParams({
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-04-01T00:00:00.000Z',
      bucket: 'hour',
    }))).toContain('maximum of 1464 buckets');
  });

  it('returns a 400 result when the daily bucket window exceeds the cap', () => {
    expect(expectRangeError(new URLSearchParams({
      since: '2025-01-01T00:00:00.000Z',
      until: '2026-06-01T00:00:00.000Z',
    }))).toContain('maximum of 371 buckets');
  });

  it('still accepts a valid capped hourly range', () => {
    const r = expectRange(new URLSearchParams({
      since: '2026-05-01T00:00:00.000Z',
      until: '2026-05-02T00:00:00.000Z',
      bucket: 'hour',
    }));
    expect(r.bucket).toBe('hour');
    expect(r.since.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(r.until.toISOString()).toBe('2026-05-02T00:00:00.000Z');
  });
});

describe('zeroFillSeries', () => {
  it('fills every day bucket in the window, merging present rows', () => {
    const rows = [{
      bucket_start: '2026-05-31T00:00:00.000Z', spend_microcents: 500, input_tokens: 10, output_tokens: 4, requests: 2,
      unknown_cost_requests: 1, actual_costs_qualified: false,
    }];
    const filled = zeroFillSeries(
      rows,
      new Date('2026-05-30T00:00:00.000Z'),
      new Date('2026-06-01T00:00:00.000Z'),
      'day',
    );
    expect(filled).toHaveLength(2); // 05-30, 05-31
    expect(filled[0]).toEqual({
      bucket_start: '2026-05-30T00:00:00.000Z', spend_microcents: 0, input_tokens: 0, output_tokens: 0, requests: 0,
      unknown_cost_requests: 0, actual_costs_qualified: true,
    });
    expect(filled[1]).toMatchObject({
      bucket_start: '2026-05-31T00:00:00.000Z', spend_microcents: 500, requests: 2,
      unknown_cost_requests: 1, actual_costs_qualified: false,
    });
  });

  it('fills hour buckets when bucket=hour', () => {
    const filled = zeroFillSeries([], new Date('2026-06-01T00:00:00.000Z'), new Date('2026-06-01T03:00:00.000Z'), 'hour');
    expect(filled).toHaveLength(3);
    expect(filled.map((b) => b.bucket_start)).toEqual([
      '2026-06-01T00:00:00.000Z', '2026-06-01T01:00:00.000Z', '2026-06-01T02:00:00.000Z',
    ]);
  });
});

describe('buildContributions', () => {
  it('zero-fills the contribution window and assigns levels relative to the window max', () => {
    const raw = [
      { date: '2026-05-31', spend_microcents: 1000, tokens: 50, unknown_cost_requests: 1, actual_costs_qualified: false },
      { date: '2026-06-01', spend_microcents: 250, tokens: 5, unknown_cost_requests: 0, actual_costs_qualified: true },
    ];
    const out = buildContributions(raw, 3, NOW); // window: 05-30, 05-31, 06-01
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ date: '2026-05-30', spend_microcents: 0, tokens: 0, unknown_cost_requests: 0, actual_costs_qualified: true, level: 0 });
    expect(out[1]).toEqual({ date: '2026-05-31', spend_microcents: 1000, tokens: 50, unknown_cost_requests: 1, actual_costs_qualified: false, level: 4 }); // == max
    expect(out[2]).toEqual({ date: '2026-06-01', spend_microcents: 250, tokens: 5, unknown_cost_requests: 0, actual_costs_qualified: true, level: 1 }); // 25% of max
  });

  it('levels are 0 when there is no spend anywhere', () => {
    const out = buildContributions([], 2, NOW);
    expect(out.every((d) => d.level === 0)).toBe(true);
  });
});

describe('levelFor', () => {
  it('maps spend/max ratios into 0..4 buckets at quartile boundaries', () => {
    expect(levelFor(0, 1000)).toBe(0);
    expect(levelFor(100, 0)).toBe(0); // no max -> 0
    expect(levelFor(1, 1000)).toBe(1); // any nonzero spend -> at least 1
    expect(levelFor(250, 1000)).toBe(1); // 0.25 -> ceil(1.0)=1
    expect(levelFor(251, 1000)).toBe(2); // just over 0.25
    expect(levelFor(500, 1000)).toBe(2); // 0.50
    expect(levelFor(501, 1000)).toBe(3);
    expect(levelFor(750, 1000)).toBe(3); // 0.75
    expect(levelFor(751, 1000)).toBe(4);
    expect(levelFor(1000, 1000)).toBe(4); // == max
  });
});
