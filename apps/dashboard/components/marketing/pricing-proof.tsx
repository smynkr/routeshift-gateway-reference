'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check } from 'lucide-react';
import { calculateSavingsScenario } from '@/lib/savings-simulator';

const MIN_MONTHLY_SPEND_USD = 1_000;
const MAX_MONTHLY_SPEND_USD = 100_000;
const DEFAULT_MONTHLY_SPEND_USD = 10_000;
const DEFAULT_PRESET_ID = 'balanced';
const MEASURED_SAVINGS_PERCENT = { low: 30, standard: 20, premium: 10 } as const;
const FLAT_MARKUP_PERCENT = 5;

const MIX_PRESETS = [
  {
    id: 'code-heavy',
    label: 'Code-heavy 70/20/10',
    modelMix: { low: 70, standard: 20, premium: 10 },
  },
  {
    id: 'balanced',
    label: 'Balanced 50/30/20',
    modelMix: { low: 50, standard: 30, premium: 20 },
  },
  {
    id: 'premium-heavy',
    label: 'Premium-heavy 20/30/50',
    modelMix: { low: 20, standard: 30, premium: 50 },
  },
] as const;

type MixPresetId = (typeof MIX_PRESETS)[number]['id'];

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

export function PricingProof() {
  const [monthlySpendUsd, setMonthlySpendUsd] = useState(DEFAULT_MONTHLY_SPEND_USD);
  const [selectedPresetId, setSelectedPresetId] = useState<MixPresetId>(DEFAULT_PRESET_ID);
  const selectedPreset = MIX_PRESETS.find((preset) => preset.id === selectedPresetId) ?? MIX_PRESETS[1];
  const scenario = useMemo(() => {
    return calculateSavingsScenario({
      monthlySpendUsd,
      modelMix: selectedPreset.modelMix,
      measuredSavingsPercent: MEASURED_SAVINGS_PERCENT,
      flatMarkupPercent: FLAT_MARKUP_PERCENT,
    });
  }, [monthlySpendUsd, selectedPreset]);

  if ('error' in scenario) {
    throw new Error(`Invalid pricing scenario: ${scenario.error}`);
  }

  return (
    <section id="pricing" aria-labelledby="pricing-proof-heading" className="scroll-mt-16 border-b border-white/[0.04] py-20 sm:py-24">
      <div className="mx-auto max-w-5xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-emerald-400">Pricing proof</p>
          <h2 id="pricing-proof-heading" className="font-heading mt-3 text-4xl italic tracking-tight text-white sm:text-5xl">
            Pay when measured savings exist.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-zinc-400 sm:text-lg">
            The public plan starts at zero platform fee. The savings share follows the measured outcome, not request volume.
          </p>
        </div>

        <div className="mt-10 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.04] p-6 sm:p-8">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-300">RouteShift pricing</p>
              <p className="mt-4 text-4xl font-semibold tracking-tight text-white">$0 monthly platform fee</p>
              <p className="mt-3 text-lg font-medium text-emerald-200">+ 3% × positive measured savings</p>
              <p className="mt-2 text-xs text-zinc-400">Active BYOK plans pay the share only when savings are positive.</p>
              <ul className="mt-6 space-y-3">
                {['No platform fee to start', 'Measured savings are the fee basis', 'No savings means no savings-share fee'].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-zinc-300">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-[#0c0c0e] p-5 sm:p-6">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-zinc-400">Worked example</p>

              <div className="mt-5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <label htmlFor="pricing-monthly-spend" className="text-sm font-medium text-white">Monthly spend</label>
                  <output htmlFor="pricing-monthly-spend" aria-live="polite" className="font-mono text-sm text-emerald-200">
                    {formatUsd(monthlySpendUsd)}
                  </output>
                </div>
                <input
                  id="pricing-monthly-spend"
                  type="range"
                  min={MIN_MONTHLY_SPEND_USD}
                  max={MAX_MONTHLY_SPEND_USD}
                  step={1_000}
                  value={monthlySpendUsd}
                  onChange={(event) => setMonthlySpendUsd(Number(event.target.value))}
                  className="mt-4 w-full accent-emerald-400"
                  aria-label="Monthly spend"
                />
                <div className="mt-2 flex justify-between text-xs text-zinc-400">
                  <span>{formatUsd(MIN_MONTHLY_SPEND_USD)}</span>
                  <span>{formatUsd(MAX_MONTHLY_SPEND_USD)}</span>
                </div>

                <fieldset className="mt-5">
                  <legend className="text-sm font-medium text-white">Model mix</legend>
                  <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Model mix presets">
                    {MIX_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        aria-pressed={selectedPresetId === preset.id}
                        onClick={() => setSelectedPresetId(preset.id)}
                        className={`rounded-full border px-3 py-2 text-sm ${
                          selectedPresetId === preset.id
                            ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-300'
                            : 'border-white/[0.1] text-zinc-400 hover:border-white/[0.2] hover:text-white'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <p className="mt-4 text-xs leading-relaxed text-zinc-400">
                  Assumes 30/20/10% measured savings by tier vs a 5% flat markup — adjust spend and mix.
                </p>
              </div>

              <p className="mt-5 text-xl font-semibold text-white">
                {formatUsd(monthlySpendUsd)} <span className="text-zinc-400">→</span> {formatUsd(scenario.measuredSavingsUsd)} measured savings
              </p>
              <dl className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-white/[0.07] bg-black/20 p-3">
                  <dt className="text-xs uppercase tracking-[0.12em] text-zinc-400">Measured savings</dt>
                  <dd className="mt-1 text-base font-semibold text-white">{formatUsd(scenario.measuredSavingsUsd)}</dd>
                </div>
                <div className="rounded-lg border border-white/[0.07] bg-black/20 p-3">
                  <dt className="text-xs uppercase tracking-[0.12em] text-zinc-400">RouteShift 3% fee</dt>
                  <dd className="mt-1 text-base font-semibold text-emerald-300">{formatUsd(scenario.routeShiftFeeUsd)}</dd>
                </div>
                <div className="rounded-lg border border-white/[0.07] bg-black/20 p-3">
                  <dt className="text-xs uppercase tracking-[0.12em] text-zinc-400">Flat-5% comparison</dt>
                  <dd className="mt-1 text-base font-semibold text-white">{formatUsd(scenario.flatMarkupFeeUsd)}</dd>
                </div>
                <div className="rounded-lg border border-white/[0.07] bg-black/20 p-3">
                  <dt className="text-xs uppercase tracking-[0.12em] text-zinc-400">Difference</dt>
                  <dd className="mt-1 text-base font-semibold text-white">{formatUsd(scenario.routeShiftDifferenceUsd)}</dd>
                </div>
              </dl>
              <p className="mt-4 text-sm leading-relaxed text-zinc-400">
                This fixed illustration applies the documented model mix and measured savings assumptions through the shared savings calculator.
              </p>
              <p className="mt-4 text-sm font-medium text-zinc-200">$0 savings share when savings are zero</p>
              <div className="mt-5 border-t border-white/[0.08] pt-4">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-300">
                  Illustrative assumptions — not customer outcomes
                </p>
                <div className="mt-3 space-y-2 text-sm leading-relaxed text-zinc-300">
                  <p>Monthly spend: {formatUsd(monthlySpendUsd)}</p>
                  <p>Model mix: {selectedPreset.modelMix.low}% low-cost / {selectedPreset.modelMix.standard}% standard / {selectedPreset.modelMix.premium}% premium</p>
                  <p>Measured savings assumptions: {MEASURED_SAVINGS_PERCENT.low}% / {MEASURED_SAVINGS_PERCENT.standard}% / {MEASURED_SAVINGS_PERCENT.premium}% (low-cost / standard / premium)</p>
                  <p>Comparison-only baseline: {FLAT_MARKUP_PERCENT}% flat markup</p>
                  <p>Comparison-only flat-markup fee: {formatUsd(scenario.flatMarkupFeeUsd)}</p>
                  <p>Difference vs RouteShift savings-share fee: {formatUsd(scenario.routeShiftDifferenceUsd)}</p>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <details className="rounded-xl border border-white/[0.08] bg-black/20 p-4">
              <summary className="cursor-pointer text-sm font-medium text-white">BYOK provider spend</summary>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                In BYOK mode, provider spend has 0% markup. Active paid plans use the savings-share formula above: 3% of positive measured savings; provider charges remain separate. Missing provider credentials fail closed; BYOK never falls back to a RouteShift-funded key.
              </p>
            </details>
            <details className="rounded-xl border border-white/[0.08] bg-black/20 p-4">
              <summary className="cursor-pointer text-sm font-medium text-white">Credits mode</summary>
              <p className="mt-3 text-sm leading-relaxed text-zinc-400">
                An active paid plan in credits mode is billed at provider-plus-plugin cost + 3% credits markup. Credits pricing is separate from BYOK savings-share pricing.
              </p>
            </details>
          </div>
          <Link href="/register" className="mt-7 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200">
            Create free account
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  );
}
