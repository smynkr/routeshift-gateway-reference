/**
 * Provider-neutral, deterministic post-pricing adjustments. This deliberately
 * does not infer provider contracts: callers must translate an approved
 * provider/product rule into one of these generic modifiers before using it.
 */
export interface PricingModifierProvenance {
  source: string;
  reference: string;
}

interface PricingModifierBase {
  /** Unique within a context; also the deterministic tie-breaker for priority. */
  id: string;
  /** Lower values apply first. */
  priority: number;
  provenance: PricingModifierProvenance;
}

export interface FixedMicrocentsPricingModifier extends PricingModifierBase {
  kind: 'fixed_microcents';
  amount_microcents: number;
}

export interface MultiplierBasisPointsPricingModifier extends PricingModifierBase {
  kind: 'multiplier_basis_points';
  /** A 100 basis-point modifier increases the current total by 1%. */
  basis_points: number;
}

export type PricingModifier = FixedMicrocentsPricingModifier | MultiplierBasisPointsPricingModifier;

export interface PricingContext {
  /** Canonical internal money unit; must be a non-negative safe integer. */
  base_cost_microcents: number;
  modifiers: readonly PricingModifier[];
}

export interface AppliedPricingModifier {
  id: string;
  kind: PricingModifier['kind'];
  priority: number;
  provenance: PricingModifierProvenance;
  before_microcents: number;
  after_microcents: number;
}

export interface ResolvedPricingContext {
  ok: true;
  base_cost_microcents: number;
  total_cost_microcents: number;
  applied_modifiers: AppliedPricingModifier[];
}

export type PricingModifierFailureCode =
  | 'invalid_base_cost'
  | 'invalid_modifier'
  | 'unsupported_modifier'
  | 'duplicate_modifier_id'
  | 'unsafe_integer'
  | 'negative_total';

export interface RejectedPricingContext {
  ok: false;
  code: PricingModifierFailureCode;
  message: string;
  modifier_id?: string;
}

export type PricingContextResolution = ResolvedPricingContext | RejectedPricingContext;

function reject(
  code: PricingModifierFailureCode,
  message: string,
  modifier_id?: string,
): RejectedPricingContext {
  return { ok: false, code, message, ...(modifier_id === undefined ? {} : { modifier_id }) };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function hasValidBaseFields(modifier: Record<string, unknown>): modifier is Record<string, unknown> & PricingModifierBase {
  const provenance = modifier.provenance as Record<string, unknown> | null;
  const source = provenance?.source;
  const reference = provenance?.reference;
  return typeof modifier.id === 'string'
    && modifier.id.length > 0
    && isSafeInteger(modifier.priority)
    && typeof modifier.provenance === 'object'
    && modifier.provenance !== null
    && typeof source === 'string'
    && source.length > 0
    && typeof reference === 'string'
    && reference.length > 0;
}

/**
 * Resolves a generic modifier stack without mutating the legacy token-cost
 * calculation. Unknown, invalid, or unsafe modifiers reject the whole context
 * before any caller can treat a partial result as billable.
 */
export function resolvePricingContext(context: PricingContext): PricingContextResolution {
  if (!isSafeInteger(context.base_cost_microcents) || context.base_cost_microcents < 0) {
    return reject('invalid_base_cost', 'base_cost_microcents must be a non-negative safe integer');
  }
  if (!Array.isArray(context.modifiers)) {
    return reject('invalid_modifier', 'modifiers must be an array');
  }

  const ids = new Set<string>();
  const modifiers: PricingModifier[] = [];
  for (const candidate of context.modifiers as readonly unknown[]) {
    if (typeof candidate !== 'object' || candidate === null || !hasValidBaseFields(candidate as Record<string, unknown>)) {
      return reject('invalid_modifier', 'Pricing modifier has invalid metadata');
    }
    const modifier = candidate as Record<string, unknown> & PricingModifierBase;
    if (ids.has(modifier.id)) return reject('duplicate_modifier_id', `Duplicate pricing modifier id: ${modifier.id}`, modifier.id);
    ids.add(modifier.id);

    if (modifier.kind !== 'fixed_microcents' && modifier.kind !== 'multiplier_basis_points') {
      const kind = typeof modifier.kind === 'string' ? modifier.kind : '(missing)';
      return reject('unsupported_modifier', `Unsupported pricing modifier kind: ${kind}`, modifier.id);
    }
    if (modifier.kind === 'fixed_microcents' && !isSafeInteger(modifier.amount_microcents)) {
      return reject('invalid_modifier', 'fixed_microcents requires an integer amount_microcents', modifier.id);
    }
    if (modifier.kind === 'multiplier_basis_points'
      && (!isSafeInteger(modifier.basis_points) || modifier.basis_points < -10_000)) {
      return reject('invalid_modifier', 'multiplier_basis_points requires integer basis_points >= -10000', modifier.id);
    }
    modifiers.push(modifier as unknown as PricingModifier);
  }

  modifiers.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  let total = context.base_cost_microcents;
  const applied_modifiers: AppliedPricingModifier[] = [];

  for (const modifier of modifiers) {
    const before_microcents = total;
    let after_microcents: number;
    if (modifier.kind === 'fixed_microcents') {
      after_microcents = total + (modifier.amount_microcents as number);
    } else {
      const numerator = total * (10_000 + (modifier.basis_points as number));
      if (!Number.isSafeInteger(numerator)) {
        return reject('unsafe_integer', 'Pricing modifier multiplication exceeds safe integer precision', modifier.id);
      }
      after_microcents = Math.round(numerator / 10_000);
    }
    if (!Number.isSafeInteger(after_microcents)) {
      return reject('unsafe_integer', 'Pricing modifier result exceeds safe integer precision', modifier.id);
    }
    if (after_microcents < 0) {
      return reject('negative_total', 'Pricing modifiers cannot produce a negative total', modifier.id);
    }
    total = after_microcents;
    applied_modifiers.push({
      id: modifier.id,
      kind: modifier.kind,
      priority: modifier.priority,
      provenance: modifier.provenance,
      before_microcents,
      after_microcents,
    });
  }

  return {
    ok: true,
    base_cost_microcents: context.base_cost_microcents,
    total_cost_microcents: total,
    applied_modifiers,
  };
}
