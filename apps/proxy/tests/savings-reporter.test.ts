import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({
    connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
  }),
}));

import { computeSavingsShareCents, reportSavings } from '../src/billing/savings-reporter.js';

// Unit convention: 1 USD = 100_000_000 microcents, so 1 cent = 1_000_000 microcents.
const USD = 100_000_000; // microcents per dollar

describe('computeSavingsShareCents', () => {
  it('bills 3% of savings, not 300% (regression: the /1e6 100x overbill)', () => {
    // Team saved $100 -> 3% share = $3 = 300 cents.
    const savings = 100 * USD; // 1e10 microcents
    expect(computeSavingsShareCents(savings, 3)).toBe(300);
  });

  it('scales linearly with savings', () => {
    expect(computeSavingsShareCents(1000 * USD, 3)).toBe(3000); // $1000 -> $30
    expect(computeSavingsShareCents(10 * USD, 3)).toBe(30); //   $10   -> $0.30
  });

  it('returns 0 for zero savings or zero share', () => {
    expect(computeSavingsShareCents(0, 3)).toBe(0);
    expect(computeSavingsShareCents(100 * USD, 0)).toBe(0);
  });

  // RSH-134 §4.4. A quality cascade can legitimately cost more than the
  // requested model, so savings_microcents goes negative for real now — not
  // just in the documented upward-fallback edge case. A negative share would
  // emit a Stripe meter event that CREDITS the customer.
  it('never returns a negative share (RSH-134 §4.4 floor)', () => {
    expect(computeSavingsShareCents(-100 * USD, 3)).toBe(0);
    expect(computeSavingsShareCents(-1, 3)).toBe(0);
    expect(computeSavingsShareCents(Number.MIN_SAFE_INTEGER, 3)).toBe(0);
  });

  // The floor above guards only the savings operand. A negative share percent
  // reaches the identical outcome — a meter event that CREDITS the customer —
  // one argument over. Not reachable via getPlanLimits (0 or 3), which is
  // precisely the caller-dependent reasoning this boundary refuses to rely on.
  it('never returns a negative share for a negative percent either', () => {
    expect(computeSavingsShareCents(100 * USD, -3)).toBe(0);
    expect(computeSavingsShareCents(100 * USD, Number.MIN_SAFE_INTEGER)).toBe(0);
    // Both operands negative must not multiply back into a positive charge.
    expect(computeSavingsShareCents(-100 * USD, -3)).toBe(0);
  });

  // A non-finite value reaching Stripe is not a rounding nit: `value:` is
  // String(shareCents), so this bills a literal "NaN"/"Infinity". `=== 0` in
  // reportSavings does not catch either, so they would sail past the skip.
  it('returns 0 for non-finite inputs rather than metering NaN/Infinity', () => {
    expect(computeSavingsShareCents(NaN, 3)).toBe(0);
    expect(computeSavingsShareCents(100 * USD, NaN)).toBe(0);
    expect(computeSavingsShareCents(Infinity, 3)).toBe(0);
    expect(computeSavingsShareCents(-Infinity, 3)).toBe(0);
    expect(computeSavingsShareCents(100 * USD, Infinity)).toBe(0);
  });

  it('rounds to whole cents', () => {
    // $1 saved at 3% = 3 cents exactly.
    expect(computeSavingsShareCents(1 * USD, 3)).toBe(3);
    // $0.10 saved at 3% = 0.3 cents -> rounds to 0.
    expect(computeSavingsShareCents(0.1 * USD, 3)).toBe(0);
    // $0.20 saved at 3% = 0.6 cents -> rounds to 1.
    expect(computeSavingsShareCents(0.2 * USD, 3)).toBe(1);
  });
});

// The share query is the money boundary between request_logs and Stripe.
//
// This used to assert against the file's SOURCE TEXT, which was too weak to mean
// what its test names claimed: `toContain("billing_mode = 'subscription'")`
// passes just as happily on `WHERE billing_mode = 'subscription' OR billing_mode
// = 'credits'`, and on a clamp that had been commented out. Both would bill the
// wrong traffic while the suite stayed green.
//
// Capture the SQL the reporter ACTUALLY issues instead. That needs no live
// Postgres — only the pool mock this repo already uses throughout — and it
// proves the query is executed rather than merely present in the file.
describe('savings-share window query (RSH-134 §4.4)', () => {
  const env = { ...process.env };
  let captured: string[];

  beforeEach(() => {
    captured = [];
    process.env.STRIPE_SECRET_KEY = 'sk_test_savings';
    process.env.STRIPE_METER_EVENT_NAME = 'routeshift_savings';
    mocks.clientQuery.mockReset();
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      captured.push(sql);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ pg_try_advisory_lock: true }] };
      if (sql.includes('FROM subscriptions')) {
        return { rows: [{ team_id: 'team-1', stripe_customer_id: 'cus_1', plan: 'pro', last_savings_report: '2026-01-01T00:00:00.000Z' }] };
      }
      if (sql.includes('FROM savings_reports')) return { rows: [{ window_start: '2026-01-01T00:00:00.000Z' }] };
      // Zero savings ends this team's iteration immediately after the window
      // query — enough to capture the SQL without reaching Stripe at all.
      if (sql.includes('FROM request_logs')) return { rows: [{ total_savings: '0' }] };
      return { rows: [], rowCount: 0 };
    });
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('clamps each row at zero before summing, per row not per window', async () => {
    await reportSavings();
    const windowQuery = captured.find((q) => q.includes('FROM request_logs'));
    expect(windowQuery).toBeDefined();
    // PER-ROW, not GREATEST(SUM(...), 0): one expensive cascade must contribute
    // 0 to the billed window rather than dragging down that window's real wins.
    expect(windowQuery).toContain('SUM(GREATEST(savings_microcents, 0))');
    expect(windowQuery).not.toContain('GREATEST(SUM');
  });

  it('bills only subscription traffic, with no widening disjunction', async () => {
    await reportSavings();
    const windowQuery = captured.find((q) => q.includes('FROM request_logs'))!;
    // Credit-funded teams pay through the credit ledger; billing them a savings
    // share too would double-charge.
    expect(windowQuery).toContain("billing_mode = 'subscription'");
    // The filter must stay a conjunction. An `OR billing_mode = 'credits'`
    // satisfies the assertion above while breaking the invariant it names —
    // which is exactly what the old source-text test could not distinguish.
    expect(windowQuery).not.toMatch(/\bOR\b/i);
    expect(windowQuery).not.toMatch(/credits/i);
  });

  it('excludes unknown actual-cost rows before calculating the Stripe meter value', async () => {
    await reportSavings();
    const windowQuery = captured.find((q) => q.includes('FROM request_logs'))!;
    expect(windowQuery).toContain('actual_cost_known = true');
  });
});
