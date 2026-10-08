import { describe, expect, it } from 'vitest';
import { formatUsd, humanizeTokens, formatDay } from '../../src/usage/format';

describe('formatUsd', () => {
  it('converts microcents (1 USD = 1e8) to a $ string', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(742_000_000)).toBe('$7.42');
    expect(formatUsd(100_000_000)).toBe('$1.00');
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
  });
  it('renders positive sub-cent values as non-zero spend', () => {
    expect(formatUsd(200_000)).toBe('<$0.01');
  });
  it('keeps two decimals for values at or above one cent', () => {
    expect(formatUsd(1_000_000)).toBe('$0.01');
    expect(formatUsd(1_250_000)).toBe('$0.01');
  });
  it('keeps cents precision for large values with thousands separators', () => {
    expect(formatUsd(1_250_000_000_000)).toBe('$12,500.00');
  });
});

describe('humanizeTokens', () => {
  it('humanizes magnitudes', () => {
    expect(humanizeTokens(0)).toBe('0');
    expect(humanizeTokens(950)).toBe('950');
    expect(humanizeTokens(1_200)).toBe('1.2K');
    expect(humanizeTokens(18_450_000)).toBe('18.5M');
    expect(humanizeTokens(2_300_000_000)).toBe('2.3B');
  });
});

describe('formatDay', () => {
  it('formats an ISO date to YYYY-MM-DD (UTC)', () => {
    expect(formatDay('2026-06-01T12:30:00.000Z')).toBe('2026-06-01');
  });
});
