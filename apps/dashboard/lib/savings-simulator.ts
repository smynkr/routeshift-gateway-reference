export interface SavingsSimulatorInput {
  monthlySpendUsd: number;
  modelMix: { low: number; standard: number; premium: number };
  measuredSavingsPercent: { low: number; standard: number; premium: number };
  flatMarkupPercent: number;
}

export interface SavingsSimulatorResult {
  weightedSavingsPercent: number;
  measuredSavingsUsd: number;
  routeShiftFeeUsd: number;
  flatMarkupFeeUsd: number;
  routeShiftDifferenceUsd: number;
}

const MIX_BANDS = ['low', 'standard', 'premium'] as const;
type MixBand = (typeof MIX_BANDS)[number];

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasValidBandValues(values: Record<MixBand, number>): boolean {
  return MIX_BANDS.every((band) => isFiniteNonNegative(values[band]));
}

export function calculateSavingsScenario(
  input: SavingsSimulatorInput,
): SavingsSimulatorResult | { error: string } {
  if (!isFiniteNonNegative(input.monthlySpendUsd)) {
    return { error: 'Monthly spend must be a finite, non-negative number.' };
  }

  if (!isFiniteNonNegative(input.flatMarkupPercent)) {
    return { error: 'Flat markup must be a finite, non-negative number.' };
  }

  if (!hasValidBandValues(input.modelMix) || Math.abs(
    MIX_BANDS.reduce((sum, band) => sum + input.modelMix[band], 0) - 100,
  ) > 1e-9) {
    return { error: 'Model mix percentages must sum to 100%.' };
  }

  if (!hasValidBandValues(input.measuredSavingsPercent)) {
    return { error: 'Savings assumptions must be finite, non-negative numbers.' };
  }

  const weightedSavingsPercent = MIX_BANDS.reduce(
    (sum, band) => sum + (input.modelMix[band] / 100) * input.measuredSavingsPercent[band],
    0,
  );
  const measuredSavingsUsd = input.monthlySpendUsd * (weightedSavingsPercent / 100);
  const routeShiftFeeUsd = measuredSavingsUsd * 0.03;
  const flatMarkupFeeUsd = input.monthlySpendUsd * (input.flatMarkupPercent / 100);

  return {
    weightedSavingsPercent,
    measuredSavingsUsd,
    routeShiftFeeUsd,
    flatMarkupFeeUsd,
    routeShiftDifferenceUsd: flatMarkupFeeUsd - routeShiftFeeUsd,
  };
}
