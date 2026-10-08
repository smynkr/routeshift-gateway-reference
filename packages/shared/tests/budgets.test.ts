import { describe, expect, it } from 'vitest';
import {
  compareBudgetActions,
  getBudgetWindow,
  getBudgetWindows,
  parseUsdCap,
  retryAfterSeconds,
  serializeBudgetReset,
} from '../src/budgets';

describe('getBudgetWindow', () => {
  it('uses ISO Monday and exact UTC boundaries', () => {
    const sunday = new Date('2026-08-09T23:59:59.999Z');
    expect(getBudgetWindow('weekly', sunday).periodStart.toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(getBudgetWindow('weekly', sunday).periodEnd.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    expect(getBudgetWindow('daily', sunday).periodEnd.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('resets daily at the next UTC midnight', () => {
    const t = new Date('2026-08-09T23:59:59.999Z');
    const w = getBudgetWindow('daily', t);
    expect(w.periodStart.toISOString()).toBe('2026-08-09T00:00:00.000Z');
    expect(w.periodEnd.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('starts a new weekly window at Monday 00:00:00.000Z exactly', () => {
    const mondayBoundary = new Date('2026-08-10T00:00:00.000Z');
    const w = getBudgetWindow('weekly', mondayBoundary);
    expect(w.periodStart.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    expect(w.periodEnd.toISOString()).toBe('2026-08-17T00:00:00.000Z');
  });

  it('handles Sunday-to-Monday transition across a month boundary', () => {
    const sunday = new Date('2026-08-30T23:59:59.999Z');
    expect(getBudgetWindow('weekly', sunday).periodStart.toISOString()).toBe('2026-08-24T00:00:00.000Z');
    expect(getBudgetWindow('weekly', sunday).periodEnd.toISOString()).toBe('2026-08-31T00:00:00.000Z');
  });

  it('handles February 29 in a leap year', () => {
    const leapDay = new Date('2024-02-29T12:00:00.000Z');
    const monthly = getBudgetWindow('monthly', leapDay);
    expect(monthly.periodStart.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(monthly.periodEnd.toISOString()).toBe('2024-03-01T00:00:00.000Z');
    const daily = getBudgetWindow('daily', leapDay);
    expect(daily.periodEnd.toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });

  it('starts February at UTC midnight after January', () => {
    const jan31 = new Date('2026-01-31T23:59:59.999Z');
    const w = getBudgetWindow('monthly', jan31);
    expect(w.periodStart.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(w.periodEnd.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('handles exact boundary timestamps consistently for all windows', () => {
    const boundary = new Date('2026-09-01T00:00:00.000Z');
    expect(getBudgetWindow('monthly', boundary).periodStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(getBudgetWindow('weekly', boundary).periodStart.toISOString()).toBe('2026-08-31T00:00:00.000Z');
    expect(getBudgetWindow('daily', boundary).periodEnd.toISOString()).toBe('2026-09-02T00:00:00.000Z');
  });

  it('returns the year-rollover monthly window', () => {
    const dec = new Date('2026-12-15T00:00:00.000Z');
    expect(getBudgetWindow('monthly', dec).periodEnd.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('getBudgetWindows', () => {
  it('returns all three windows for one timestamp', () => {
    const windows = getBudgetWindows(new Date('2026-08-09T23:59:59.999Z'));
    expect(windows.map((w) => w.kind)).toEqual(['daily', 'weekly', 'monthly']);
    expect(windows.map((w) => w.resetAt)).toEqual([
      '2026-08-10T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ]);
  });
});

describe('parseUsdCap', () => {
  it('parses decimal cap spellings without binary-float rejection', () => {
    expect(parseUsdCap(0.07)).toEqual({ usd: 0.07, microcents: 7_000_000 });
    expect(parseUsdCap(8.29)).toEqual({ usd: 8.29, microcents: 829_000_000 });
    expect(parseUsdCap('99.99')).toEqual({ usd: 99.99, microcents: 9_999_000_000 });
    expect(parseUsdCap('0.000000001')).toBeNull();
    expect(parseUsdCap(Number.NaN)).toBeNull();
    expect(parseUsdCap(-1)).toBeNull();
  });

  it('accepts integers and zero', () => {
    expect(parseUsdCap(0)).toEqual({ usd: 0, microcents: 0 });
    expect(parseUsdCap(25)).toEqual({ usd: 25, microcents: 2_500_000_000 });
    expect(parseUsdCap('150')).toEqual({ usd: 150, microcents: 15_000_000_000 });
  });

  it('accepts up to eight fractional decimal places exactly', () => {
    expect(parseUsdCap('0.00000001')).toEqual({ usd: 0.00000001, microcents: 1 });
    expect(parseUsdCap('1.23456789' /* eight places */)).toEqual({ usd: 1.23456789, microcents: 123_456_789 });
  });

  it('rejects non-finite, boolean, null, object, and unsafe values', () => {
    expect(parseUsdCap(Infinity)).toBeNull();
    expect(parseUsdCap(-Infinity)).toBeNull();
    expect(parseUsdCap(true)).toBeNull();
    expect(parseUsdCap(null)).toBeNull();
    expect(parseUsdCap({})).toBeNull();
    expect(parseUsdCap('abc')).toBeNull();
    expect(parseUsdCap('')).toBeNull();
    // microcents above Number.MAX_SAFE_INTEGER must be rejected, not rounded
    expect(parseUsdCap('90071993')).toBeNull();
    expect(parseUsdCap(90071992.54740991 * 100)).toBeNull();
  });

  it('rejects more than eight decimal places and negative spellings', () => {
    expect(parseUsdCap('0.0000000100000001')).toBeNull();
    expect(parseUsdCap('-0.5')).toBeNull();
    expect(parseUsdCap('1e-9')).toBeNull();
  });

  it('converts to microcents with the 100_000_000 factor', () => {
    expect(parseUsdCap(1)!.microcents).toBe(100_000_000);
    expect(parseUsdCap('0.005')!.microcents).toBe(500_000);
  });
});

describe('compareBudgetActions', () => {
  it('ranks block highest and ok lowest', () => {
    expect(compareBudgetActions('ok', 'block')).toBe(-1);
    expect(compareBudgetActions('block', 'throttle')).toBe(1);
    expect(compareBudgetActions('alert', 'alert')).toBe(0);
    expect(compareBudgetActions('throttle', 'ok')).toBe(1);
    expect(compareBudgetActions('block', 'block')).toBe(0);
  });
});

describe('serializeBudgetReset', () => {
  it('serializes the reset time as ISO', () => {
    const w = getBudgetWindow('daily', new Date('2026-08-09T01:00:00.000Z'));
    expect(serializeBudgetReset(w)).toBe('2026-08-10T00:00:00.000Z');
    expect(w.resetAt).toBe('2026-08-10T00:00:00.000Z');
  });
});

describe('retryAfterSeconds', () => {
  it('is the non-negative ceiling of remaining UTC seconds', () => {
    const reset = new Date('2026-08-10T00:00:00.000Z');
    // 60.4s remaining -> 61
    expect(retryAfterSeconds(reset, new Date('2026-08-09T23:58:59.600Z'))).toBe(61);
    expect(retryAfterSeconds(reset, new Date('2026-08-09T23:59:00.000Z'))).toBe(60);
    // exactly at reset -> 0
    expect(retryAfterSeconds(reset, reset)).toBe(0);
    // past reset -> clamped to 0
    expect(retryAfterSeconds(reset, new Date('2026-08-10T00:00:01.500Z'))).toBe(0);
  });
});
