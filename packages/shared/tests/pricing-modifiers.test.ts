import { describe, expect, it } from 'vitest';
import {
  resolvePricingContext,
  type PricingContext,
  type PricingModifier,
} from '../src/pricing-modifiers';

const provenance = { source: 'test', reference: 'pricing-modifiers.test.ts' };

function context(modifiers: PricingModifier[]): PricingContext {
  return { base_cost_microcents: 100_000_000, modifiers };
}

describe('pricing modifiers', () => {
  it('orders modifiers by priority then id and preserves provenance', () => {
    const result = resolvePricingContext(context([
      { id: 'markup', priority: 20, kind: 'multiplier_basis_points', basis_points: 1_000, provenance },
      { id: 'platform-fee', priority: 10, kind: 'fixed_microcents', amount_microcents: 25_000_000, provenance },
    ]));

    expect(result).toEqual({
      ok: true,
      base_cost_microcents: 100_000_000,
      total_cost_microcents: 137_500_000,
      applied_modifiers: [
        expect.objectContaining({ id: 'platform-fee', before_microcents: 100_000_000, after_microcents: 125_000_000, provenance }),
        expect.objectContaining({ id: 'markup', before_microcents: 125_000_000, after_microcents: 137_500_000, provenance }),
      ],
    });
  });

  it('stacks percentage modifiers sequentially with integer microcent rounding', () => {
    const result = resolvePricingContext(context([
      { id: 'first', priority: 1, kind: 'multiplier_basis_points', basis_points: 500, provenance },
      { id: 'second', priority: 2, kind: 'multiplier_basis_points', basis_points: 500, provenance },
    ]));

    expect(result).toMatchObject({ ok: true, total_cost_microcents: 110_250_000 });
  });

  it('uses modifier id as a deterministic tie-breaker', () => {
    const result = resolvePricingContext(context([
      { id: 'z-last', priority: 1, kind: 'multiplier_basis_points', basis_points: 10_000, provenance },
      { id: 'a-first', priority: 1, kind: 'fixed_microcents', amount_microcents: 50_000_000, provenance },
    ]));

    expect(result).toMatchObject({ ok: true, total_cost_microcents: 300_000_000 });
    if (result.ok) expect(result.applied_modifiers.map((modifier) => modifier.id)).toEqual(['a-first', 'z-last']);
  });

  it('fails closed without applying any modifier for unsupported kinds', () => {
    const result = resolvePricingContext({
      base_cost_microcents: 100_000_000,
      modifiers: [{ id: 'unknown', priority: 1, kind: 'provider_special_rate', provenance }] as unknown as PricingModifier[],
    });

    expect(result).toEqual({
      ok: false,
      code: 'unsupported_modifier',
      modifier_id: 'unknown',
      message: 'Unsupported pricing modifier kind: provider_special_rate',
    });
  });

  it('fails closed on duplicate ids and negative totals', () => {
    const duplicate = resolvePricingContext(context([
      { id: 'same', priority: 1, kind: 'fixed_microcents', amount_microcents: 1, provenance },
      { id: 'same', priority: 2, kind: 'fixed_microcents', amount_microcents: 1, provenance },
    ]));
    const negative = resolvePricingContext(context([
      { id: 'discount', priority: 1, kind: 'fixed_microcents', amount_microcents: -100_000_001, provenance },
    ]));

    expect(duplicate).toMatchObject({ ok: false, code: 'duplicate_modifier_id', modifier_id: 'same' });
    expect(negative).toMatchObject({ ok: false, code: 'negative_total', modifier_id: 'discount' });
  });

  it.each([null, {}, 'not-an-array', { 0: { id: 'not-used' }, length: 1 }])(
    'fails closed for malformed modifier containers: %p',
    (modifiers) => {
      expect(resolvePricingContext({
        base_cost_microcents: 100_000_000,
        modifiers: modifiers as unknown as PricingModifier[],
      })).toEqual({ ok: false, code: 'invalid_modifier', message: 'modifiers must be an array' });
    },
  );

  it('fails closed for sparse arrays rather than skipping the hole', () => {
    const modifiers = new Array(1) as PricingModifier[];
    expect(resolvePricingContext({ base_cost_microcents: 100_000_000, modifiers }))
      .toEqual({ ok: false, code: 'invalid_modifier', message: 'Pricing modifier has invalid metadata' });
  });
});
