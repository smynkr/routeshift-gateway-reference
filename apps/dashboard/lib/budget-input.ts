// RSH-138: dashboard-side cap-field validation shared by the billing and key
// administration surfaces. USD parsing is delegated to @routeshift/shared's
// exact decimal parser; nothing here may approximate with binary floats.

import { parseUsdCap, type BudgetWindowKind } from '@routeshift/shared';

export const BUDGET_CAP_FIELDS = ['daily_usd_cap', 'weekly_usd_cap', 'monthly_usd_cap'] as const;
export type BudgetCapField = (typeof BUDGET_CAP_FIELDS)[number];

export const CAP_FIELD_KIND: Record<BudgetCapField, BudgetWindowKind> = {
  daily_usd_cap: 'daily',
  weekly_usd_cap: 'weekly',
  monthly_usd_cap: 'monthly',
};

/**
 * Parse a single cap field value (number or decimal string) into its exact
 * microcent representation. Returns null for an explicit null (clear), and
 * throws a typed error for anything non-finite, negative, unsafe, or not
 * representable in microcents. `undefined` (omitted) is never accepted here —
 * callers distinguish omitted from explicit null before calling.
 */
export function parseCapMicrocents(value: unknown, field: BudgetCapField): number | null {
  if (value === null) return null;
  const parsed = parseUsdCap(value);
  if (parsed === null) {
    throw new Error(
      `${field} must be a non-negative number with at most 8 decimal places, or null`,
    );
  }
  return parsed.microcents;
}

export interface ParsedBudgetCaps {
  daily_usd_cap: number | null;
  weekly_usd_cap: number | null;
  monthly_usd_cap: number | null;
}

export interface CapFieldInput {
  /** Present in the request body (vs omitted). */
  supplied: boolean;
  /** Exact microcent value; null clears the cap. */
  microcents: number | null;
}

/**
 * Parse the three cap fields from an untrusted body. Omitted fields are
 * preserved (not supplied); an explicit null clears exactly that field.
 * Throws on the first invalid value.
 */
export function parseBudgetCapFields(body: Record<string, unknown>): Partial<Record<BudgetCapField, CapFieldInput>> {
  const out: Partial<Record<BudgetCapField, CapFieldInput>> = {};
  for (const field of BUDGET_CAP_FIELDS) {
    if (!(field in body)) continue;
    out[field] = {
      supplied: true,
      microcents: parseCapMicrocents(body[field], field),
    };
  }
  return out;
}

/** Microcents → USD for display (rounded to cents; display only, never re-parsed). */
export function microcentsToUsd(microcents: number): number {
  return microcents / 100_000_000;
}
