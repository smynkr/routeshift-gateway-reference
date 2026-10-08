/**
 * Shared UTC budget window primitives.
 *
 * These helpers are the single contract used by the proxy reservation ledger
 * and the dashboard for daily/weekly/monthly budget windows. Window
 * arithmetic is UTC-only (daily boundaries at 00:00Z, weekly boundaries at
 * ISO Monday 00:00Z, monthly boundaries at the first of the month 00:00Z) and
 * cap parsing is exact against the integer-microcent invariant
 * (1 USD = 100_000_000 microcents) — no binary-float comparison is ever used
 * to judge representability.
 */

export type BudgetWindowKind = 'daily' | 'weekly' | 'monthly';

export type BudgetAction = 'ok' | 'alert' | 'throttle' | 'block';
export type BudgetStatus = BudgetAction;

export interface BudgetWindow {
  kind: BudgetWindowKind;
  periodStart: Date;
  periodEnd: Date;
  resetAt: string;
}

export interface ParsedUsdCap {
  usd: number;
  microcents: number;
}

export const MICROCENTS_PER_USD = 100_000_000;

/** Fixed action rank: ok=0, alert=1, throttle=2, block=3. */
const ACTION_RANK: Record<BudgetAction, number> = {
  ok: 0,
  alert: 1,
  throttle: 2,
  block: 3,
};

function utcStartOfDay(t: Date): Date {
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
}

function computeBudgetWindow(kind: BudgetWindowKind, now: Date): BudgetWindow {
  let periodStart: Date;
  let periodEnd: Date;
  switch (kind) {
    case 'daily': {
      periodStart = utcStartOfDay(now);
      periodEnd = new Date(periodStart.getTime() + 24 * 60 * 60 * 1000);
      break;
    }
    case 'weekly': {
      const day = utcStartOfDay(now);
      // ISO week: Monday is the reset. getUTCDay(): Sunday=0, Monday=1, …
      const daysSinceMonday = (day.getUTCDay() + 6) % 7;
      periodStart = new Date(day.getTime() - daysSinceMonday * 24 * 60 * 60 * 1000);
      periodEnd = new Date(periodStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      break;
    }
    case 'monthly': {
      periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      break;
    }
  }
  return { kind, periodStart, periodEnd, resetAt: periodEnd.toISOString() };
}

export function getBudgetWindow(kind: BudgetWindowKind, now: Date): BudgetWindow {
  return computeBudgetWindow(kind, now);
}

export function getBudgetWindows(now: Date): BudgetWindow[] {
  return [
    computeBudgetWindow('daily', now),
    computeBudgetWindow('weekly', now),
    computeBudgetWindow('monthly', now),
  ];
}

const DECIMAL_CAP_RE = /^(\d+)(?:\.(\d{1,8}))?$/;

/**
 * Parse a finite number or decimal string into microcents exactly, from the
 * decimal spelling. Never multiplies a binary float by 100_000_000 to test
 * representability.
 *
 * Returns null for: non-finite/negative values, non-decimal spellings
 * (including exponent notation), more than eight fractional decimal places
 * (sub-microcent), or microcent results above Number.MAX_SAFE_INTEGER.
 */
export function parseUsdCap(value: unknown): ParsedUsdCap | null {
  let spelling: string | null = null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Normalize through the shortest decimal spelling.
    const shortest = value.toString();
    if (shortest.includes('e') || shortest.includes('E')) return null;
    spelling = shortest;
  } else if (typeof value === 'string') {
    spelling = value.trim();
  } else {
    return null;
  }

  const match = DECIMAL_CAP_RE.exec(spelling);
  if (!match) return null;
  const intPart = match[1];
  const fracPart = match[2] ?? '';
  // Build microcents with integer arithmetic: int * 1e8 + frac padded to 8 places.
  const intMicro = Number(intPart) * MICROCENTS_PER_USD;
  const fracMicro = fracPart.length === 0 ? 0 : Number(fracPart.padEnd(8, '0'));
  if (!Number.isSafeInteger(intMicro) || !Number.isSafeInteger(fracMicro)) return null;
  const microcents = intMicro + fracMicro;
  if (!Number.isSafeInteger(microcents)) return null;
  return { usd: Number(spelling), microcents };
}

/** Return -1, 0, or 1 for left lower than, equal to, or higher than right. */
export function compareBudgetActions(left: BudgetAction, right: BudgetAction): number {
  const diff = ACTION_RANK[left] - ACTION_RANK[right];
  return diff < 0 ? -1 : diff > 0 ? 1 : 0;
}

export function serializeBudgetReset(window: BudgetWindow): string {
  return window.periodEnd.toISOString();
}

/**
 * Serialize a Retry-After value as the non-negative ceiling of remaining
 * whole seconds until the reset instant, never negative.
 */
export function retryAfterSeconds(resetAt: Date, dbNow: Date): number {
  const remainingMs = resetAt.getTime() - dbNow.getTime();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}
