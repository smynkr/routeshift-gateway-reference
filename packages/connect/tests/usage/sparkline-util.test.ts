import { describe, expect, it } from 'vitest';
import { sparkline } from '../../src/usage/sparkline-util';

describe('sparkline', () => {
  it('produces one glyph per input value', () => {
    expect(sparkline([1, 2, 3, 4, 5])).toHaveLength(5);
  });
  it('renders a single positive value as a flat lowest bar', () => {
    expect(sparkline([100])).toBe('▁');
  });
  it('renders all-equal positive series as flat lowest bars', () => {
    expect(sparkline([100, 100, 100])).toBe('▁▁▁');
  });
  it('scales varied series across min..max', () => {
    const s = sparkline([50, 75, 100]);
    expect(s[0]).toBe('▁');
    expect(s[2]).toBe('█');
  });
  it('renders all-zero series as flat lowest bars', () => {
    expect(sparkline([0, 0, 0])).toBe('▁▁▁');
  });
  it('returns empty string for empty input', () => {
    expect(sparkline([])).toBe('');
  });
});
