import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks: a Stripe meter-event spy, the pg pool, and plan limits.
const { meterCreate, getPoolMock } = vi.hoisted(() => ({
  meterCreate: vi.fn(),
  getPoolMock: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({ getPool: getPoolMock }));
vi.mock('../src/billing/plan-limits.js', () => ({
  getPlanLimits: () => ({ savingsSharePercent: 3 }),
}));
vi.mock('stripe', () => ({
  default: class {
    billing = { meterEvents: { create: meterCreate } };
  },
}));

import { reportSavings } from '../src/billing/savings-reporter.js';

const USD = 100_000_000; // microcents per dollar
const WATERMARK = '2026-05-01T00:00:00.000Z'; // subscriptions.last_savings_report (concrete, prod-shaped)

/**
 * Fake pg client whose query() responds by SQL substring.
 * - `cursorWindowStart`: what `SELECT COALESCE(MAX(window_end), ...)` returns —
 *   i.e. the savings_reports-derived window cursor. Pass null to simulate
 *   genesis (no prior report), where the SQL COALESCE would fall back to the
 *   watermark; we emulate that by returning the watermark.
 * - `claimRowCount`: 1 = window claimed fresh, 0 = conflict (already billed).
 */
function makeClient({ cursorWindowStart, claimRowCount }: { cursorWindowStart: string | null; claimRowCount: number }) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ pg_try_advisory_lock: true }] };
    if (sql.includes('FROM subscriptions WHERE status')) {
      return { rows: [{ team_id: 'team_1', stripe_customer_id: 'cus_1', plan: 'growth', last_savings_report: WATERMARK }] };
    }
    if (sql.includes('MAX(window_end)')) {
      return { rows: [{ window_start: cursorWindowStart ?? WATERMARK }] };
    }
    if (sql.includes('FROM request_logs')) return { rows: [{ total_savings: String(100 * USD) }] }; // $100 saved
    if (sql.includes('INSERT INTO savings_reports')) return { rowCount: claimRowCount };
    if (sql.includes('UPDATE subscriptions SET last_savings_report')) return { rowCount: 1 };
    if (sql.includes('DELETE FROM savings_reports')) return { rowCount: 1 };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
    return { rows: [], rowCount: 0 };
  });
  return { query, release: vi.fn(), calls };
}

const sqlsOf = (c: ReturnType<typeof makeClient>) => c.calls.map((x) => x.sql);
const has = (c: ReturnType<typeof makeClient>, needle: string) => sqlsOf(c).some((s) => s.includes(needle));

describe('reportSavings idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test';
    process.env.STRIPE_METER_EVENT_NAME = 'savings';
  });

  it('derives the window from savings_reports (not the watermark) and bills it', async () => {
    // Steady state: a prior report ended at this timestamp; that is the cursor.
    const PRIOR_END = '2026-05-15T00:00:00.000Z';
    const client = makeClient({ cursorWindowStart: PRIOR_END, claimRowCount: 1 });
    getPoolMock.mockReturnValue({ connect: async () => client });
    meterCreate.mockResolvedValue({});

    await reportSavings();

    // Cursor must come from the MAX(window_end) query, not subscriptions.
    expect(has(client, 'MAX(window_end)')).toBe(true);
    expect(meterCreate).toHaveBeenCalledTimes(1);
    expect(meterCreate.mock.calls[0][0]).toMatchObject({
      identifier: `savings:team_1:${PRIOR_END}`, // window_start = savings_reports cursor
      payload: { value: '300', stripe_customer_id: 'cus_1' }, // $100 * 3% = 300¢
    });
    // The claim's window_start param must equal the derived cursor.
    const claimCall = client.calls.find((c) => c.sql.includes('INSERT INTO savings_reports'));
    expect(claimCall?.params?.[1]).toBe(PRIOR_END);
    expect(has(client, 'DELETE FROM savings_reports')).toBe(false);
  });

  it('crash-B regression: a STALE watermark is ignored; the savings_reports cursor wins', async () => {
    // Simulates the crash-point-B aftermath: a claim committed (advancing
    // MAX(window_end)) but the watermark UPDATE never ran, so the watermark is
    // BEHIND the real cursor. The run must use MAX(window_end), not the stale
    // watermark — otherwise the team would be re-billed / permanently stalled.
    const ADVANCED_CURSOR = '2026-05-20T00:00:00.000Z'; // MAX(window_end), ahead of WATERMARK (2026-05-01)
    const client = makeClient({ cursorWindowStart: ADVANCED_CURSOR, claimRowCount: 1 });
    getPoolMock.mockReturnValue({ connect: async () => client });
    meterCreate.mockResolvedValue({});

    await reportSavings();

    expect(meterCreate.mock.calls[0][0]).toMatchObject({ identifier: `savings:team_1:${ADVANCED_CURSOR}` });
    const claimCall = client.calls.find((c) => c.sql.includes('INSERT INTO savings_reports'));
    expect(claimCall?.params?.[1]).toBe(ADVANCED_CURSOR); // window_start from cursor, not WATERMARK
  });

  it('genesis: with no prior report, falls back to the subscription watermark', async () => {
    const client = makeClient({ cursorWindowStart: null, claimRowCount: 1 });
    getPoolMock.mockReturnValue({ connect: async () => client });
    meterCreate.mockResolvedValue({});

    await reportSavings();

    expect(meterCreate.mock.calls[0][0]).toMatchObject({ identifier: `savings:team_1:${WATERMARK}` });
  });

  it('does NOT bill again when the window was already claimed by a prior run', async () => {
    const client = makeClient({ cursorWindowStart: '2026-05-15T00:00:00.000Z', claimRowCount: 0 });
    getPoolMock.mockReturnValue({ connect: async () => client });
    meterCreate.mockResolvedValue({});

    await reportSavings();

    expect(meterCreate).not.toHaveBeenCalled();
    expect(has(client, 'UPDATE subscriptions SET last_savings_report')).toBe(false);
    expect(has(client, 'DELETE FROM savings_reports')).toBe(false);
  });

  it('releases the claim (so it retries) when the Stripe call fails', async () => {
    const client = makeClient({ cursorWindowStart: '2026-05-15T00:00:00.000Z', claimRowCount: 1 });
    getPoolMock.mockReturnValue({ connect: async () => client });
    meterCreate.mockRejectedValue(new Error('stripe down'));

    await reportSavings();

    expect(meterCreate).toHaveBeenCalledTimes(1);
    expect(has(client, 'UPDATE subscriptions SET last_savings_report')).toBe(false);
    expect(has(client, 'DELETE FROM savings_reports')).toBe(true);
  });

  it('does NOT release the claim when Stripe succeeds but the watermark UPDATE fails', async () => {
    // Regression: a statement-level failure on the best-effort watermark UPDATE
    // (deadlock / lock timeout / trigger error on `subscriptions`) must not be
    // mistaken for a billing failure. Deleting the already-billed claim would
    // re-bill the window on the next run, after Stripe's per-identifier dedup
    // window has lapsed — a real customer double-charge.
    const client = makeClient({ cursorWindowStart: '2026-05-15T00:00:00.000Z', claimRowCount: 1 });
    const origQuery = client.query;
    client.query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('UPDATE subscriptions SET last_savings_report')) {
        throw new Error('deadlock detected');
      }
      return origQuery(sql, params);
    }) as typeof client.query;
    getPoolMock.mockReturnValue({ connect: async () => client });
    meterCreate.mockResolvedValue({});

    await reportSavings();

    // Billed exactly once, and the claim must survive (no DELETE).
    expect(meterCreate).toHaveBeenCalledTimes(1);
    expect(client.calls.some((c) => c.sql.includes('DELETE FROM savings_reports'))).toBe(false);
    // The lock is still released even though the watermark UPDATE threw.
    expect(client.calls.some((c) => c.sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('always releases the advisory lock and the client', async () => {
    const client = makeClient({ cursorWindowStart: '2026-05-15T00:00:00.000Z', claimRowCount: 1 });
    getPoolMock.mockReturnValue({ connect: async () => client });
    meterCreate.mockResolvedValue({});

    await reportSavings();

    expect(has(client, 'pg_advisory_unlock')).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
