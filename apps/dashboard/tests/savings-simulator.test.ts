import { describe, expect, it } from 'vitest';
import { calculateSavingsScenario } from '@/lib/savings-simulator';

describe('calculateSavingsScenario', () => {
  it('charges three percent of measured savings, not three percent of spend', () => {
    const result = calculateSavingsScenario({
      monthlySpendUsd: 10_000,
      modelMix: { low: 50, standard: 30, premium: 20 },
      measuredSavingsPercent: { low: 30, standard: 20, premium: 10 },
      flatMarkupPercent: 5,
    });

    expect(result).toMatchObject({
      weightedSavingsPercent: 23,
      measuredSavingsUsd: 2_300,
      routeShiftFeeUsd: 69,
      flatMarkupFeeUsd: 500,
      routeShiftDifferenceUsd: 431,
    });
  });

  it('rejects negative, non-finite, and unbalanced inputs', () => {
    const base = {
      monthlySpendUsd: 10_000,
      modelMix: { low: 50, standard: 30, premium: 20 },
      measuredSavingsPercent: { low: 30, standard: 20, premium: 10 },
      flatMarkupPercent: 5,
    };

    expect(calculateSavingsScenario({ ...base, monthlySpendUsd: -1 })).toEqual({
      error: 'Monthly spend must be a finite, non-negative number.',
    });
    expect(calculateSavingsScenario({ ...base, flatMarkupPercent: Number.NaN })).toEqual({
      error: 'Flat markup must be a finite, non-negative number.',
    });
    expect(calculateSavingsScenario({ ...base, modelMix: { ...base.modelMix, premium: 19 } })).toEqual({
      error: 'Model mix percentages must sum to 100%.',
    });
    expect(calculateSavingsScenario({
      ...base,
      measuredSavingsPercent: { ...base.measuredSavingsPercent, low: Number.POSITIVE_INFINITY },
    })).toEqual({
      error: 'Savings assumptions must be finite, non-negative numbers.',
    });
  });

  it('does not charge a savings-share fee when measured savings are zero', () => {
    const result = calculateSavingsScenario({
      monthlySpendUsd: 1_000,
      modelMix: { low: 50, standard: 30, premium: 20 },
      measuredSavingsPercent: { low: 0, standard: 0, premium: 0 },
      flatMarkupPercent: 5,
    });

    expect(result).toMatchObject({
      weightedSavingsPercent: 0,
      measuredSavingsUsd: 0,
      routeShiftFeeUsd: 0,
      flatMarkupFeeUsd: 50,
      routeShiftDifferenceUsd: 50,
    });
  });
});
