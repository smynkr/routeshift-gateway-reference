import { describe, expect, it } from 'vitest';
import {
  qualityDerankFactor,
  QUALITY_DERANK_FACTOR_FLOOR,
  QUALITY_DERANK_MIN_SAMPLES,
  QUALITY_DERANK_PASS_THRESHOLD,
} from '../src/quality-derank';

describe('qualityDerankFactor', () => {
  it('returns 1.0 below the minimum sample count (insufficient data is NOT a verdict)', () => {
    expect(qualityDerankFactor(0, 0)).toBe(1);
    expect(qualityDerankFactor(9, 0)).toBe(1); // 9 samples, perfect rate, still no signal
    expect(qualityDerankFactor(0, 9)).toBe(1); // 9 samples, zero rate, still no signal
    expect(qualityDerankFactor(4, 5)).toBe(1); // 9 samples total
  });

  it('returns exactly 1.0 at or above the pass threshold (healthy)', () => {
    const at = QUALITY_DERANK_MIN_SAMPLES;
    expect(qualityDerankFactor(at, 0)).toBe(1);
    expect(qualityDerankFactor(9 * at, at)).toBe(1); // 0.9
    expect(qualityDerankFactor(18, 2)).toBe(1); // 0.9
  });

  it('penalizes below-threshold pass rates linearly into a floor, never zero', () => {
    // ABSOLUTE pins (not just relative to the exported constant): changing
    // the floor constant and implementation together must not pass silently
    expect(qualityDerankFactor(10, 10)).toBeCloseTo(0.3, 10); // pass rate 0.5 → floor
    expect(qualityDerankFactor(0, 20)).toBeCloseTo(0.3, 10); // pass rate 0.0 → floor
    expect(qualityDerankFactor(14, 6)).toBeCloseTo(0.65, 10); // pass rate 0.7 → midpoint
    expect(qualityDerankFactor(16, 4)).toBeCloseTo(0.825, 10); // pass rate 0.8 → quarter
    // never zero, never negative, never above one
    for (const [v, r] of [[10, 10], [11, 9], [0, 30], [30, 0], [1, 100]]) {
      const f = qualityDerankFactor(v, r);
      expect(f).toBeGreaterThan(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it('is monotone in the pass rate once samples are sufficient', () => {
    const worse = qualityDerankFactor(10, 10); // 0.5
    const better = qualityDerankFactor(15, 5); // 0.75
    const best = qualityDerankFactor(18, 2); // 0.9
    expect(worse).toBeLessThan(better);
    expect(better).toBeLessThan(best);
    expect(best).toBe(1);
  });
});

describe('derank contract bounds', () => {
  it('factor floor is a named constant in (0, 1)', () => {
    expect(QUALITY_DERANK_FACTOR_FLOOR).toBeGreaterThan(0);
    expect(QUALITY_DERANK_FACTOR_FLOOR).toBeLessThan(1);
    expect(QUALITY_DERANK_PASS_THRESHOLD).toBeGreaterThan(0.5);
    expect(QUALITY_DERANK_MIN_SAMPLES).toBeGreaterThanOrEqual(5);
  });
});
