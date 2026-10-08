import { describe, expect, it } from 'vitest';
import {
  buildBudgetReport,
  selectStrictestBudgetWindow,
  type BudgetWindowInput,
  type BudgetWindowLedgerRow,
} from '../src/budget-report';

const ledger = (overrides: Partial<BudgetWindowLedgerRow> = {}): BudgetWindowLedgerRow => ({
  kind: 'daily',
  periodStart: '2026-08-09T00:00:00.000Z',
  periodEnd: '2026-08-10T00:00:00.000Z',
  resetAt: '2026-08-10T00:00:00.000Z',
  actualMicrocents: 0,
  reservedMicrocents: 0,
  unknownHeldMicrocents: 0,
  unknownCostRequests: 0,
  ...overrides,
});

const input = (overrides: Partial<BudgetWindowInput> = {}): BudgetWindowInput => ({
  kind: 'daily',
  capMicrocents: null,
  hardAction: null,
  alertAtPct: null,
  ledger: null,
  hasUnboundedUnknown: false,
  ...overrides,
});

describe('buildBudgetReport', () => {
  it('reports a never-seeded window with no cap as ok with zero committed', () => {
    const report = buildBudgetReport({ windows: [input({ kind: 'daily' })] });
    expect(report.windows[0]).toMatchObject({ status: 'ok', committedMicrocents: 0, capMicrocents: null });
    expect(report.actualCostsQualified).toBe(true);
  });

  it('sums actual + unknown_held + reserved into committed exactly once', () => {
    const report = buildBudgetReport({
      windows: [input({
        capMicrocents: 10_000_000_000,
        hardAction: 'block',
        ledger: ledger({
          actualMicrocents: 1_000_000_000,
          reservedMicrocents: 2_000_000_000,
          unknownHeldMicrocents: 500_000_000,
        }),
      })],
    });
    expect(report.windows[0].committedMicrocents).toBe(3_500_000_000);
  });

  it('engages the hard status when committed strictly exceeds the cap', () => {
    const report = buildBudgetReport({
      windows: [input({
        capMicrocents: 5,
        hardAction: 'throttle',
        ledger: ledger({ actualMicrocents: 6 }),
      })],
    });
    expect(report.windows[0].status).toBe('throttle');
  });

  it('does not engage hard status at exact-cap equality', () => {
    const report = buildBudgetReport({
      windows: [input({
        capMicrocents: 100,
        hardAction: 'block',
        ledger: ledger({ actualMicrocents: 100 }),
      })],
    });
    expect(report.windows[0].status).not.toBe('block');
  });

  it('flags the alert threshold with exact integer comparison', () => {
    const report = buildBudgetReport({
      windows: [input({
        capMicrocents: 100,
        hardAction: 'block',
        alertAtPct: 80,
        ledger: ledger({ actualMicrocents: 80 }),
      })],
    });
    expect(report.windows[0].status).toBe('alert');
  });

  it('unqualified when bounded unknowns are unresolved', () => {
    const report = buildBudgetReport({
      windows: [input({
        capMicrocents: 1_000,
        hardAction: 'block',
        ledger: ledger({ unknownHeldMicrocents: 10, unknownCostRequests: 1 }),
      })],
    });
    expect(report.actualCostsQualified).toBe(false);
    expect(report.windows[0].status).not.toBe('block');
  });

  it('an active unbounded gate reports the hard status below the numeric cap', () => {
    const report = buildBudgetReport({
      windows: [input({
        capMicrocents: 1_000,
        hardAction: 'block',
        hasUnboundedUnknown: true,
        ledger: ledger({ actualMicrocents: 1 }),
      })],
    });
    expect(report.windows[0].status).toBe('block');
    expect(report.actualCostsQualified).toBe(false);
  });

  it('flags unresolved unknowns on alert-only and uncapped windows without hard status', () => {
    const alertOnly = buildBudgetReport({
      windows: [input({ hardAction: 'alert', capMicrocents: 100, ledger: ledger({ unknownCostRequests: 1 }) })],
    });
    expect(alertOnly.windows[0].status).not.toBe('block');
    const uncapped = buildBudgetReport({
      windows: [input({ hasUnboundedUnknown: true })],
    });
    expect(uncapped.windows[0].status).toBe('alert');
  });
});

describe('selectStrictestBudgetWindow', () => {
  it('prefixes rank, then earliest reset on ties', () => {
    const report = buildBudgetReport({
      windows: [
        input({ kind: 'daily', capMicrocents: 10, hardAction: 'throttle', ledger: ledger({ actualMicrocents: 11, resetAt: '2026-08-10T00:00:00.000Z' }) }),
        input({ kind: 'monthly', capMicrocents: 10, hardAction: 'block', alertAtPct: null, ledger: ledger({ kind: 'monthly', actualMicrocents: 11, resetAt: '2026-09-01T00:00:00.000Z' }) }),
      ],
    });
    expect(selectStrictestBudgetWindow(report.windows)!.kind).toBe('monthly');

    const tie = buildBudgetReport({
      windows: [
        input({ kind: 'weekly', capMicrocents: 10, hardAction: 'block', ledger: ledger({ kind: 'weekly', actualMicrocents: 11, resetAt: '2026-08-10T00:00:00.000Z' }) }),
        input({ kind: 'monthly', capMicrocents: 10, hardAction: 'block', ledger: ledger({ kind: 'monthly', actualMicrocents: 11, resetAt: '2026-09-01T00:00:00.000Z' }) }),
      ],
    });
    expect(selectStrictestBudgetWindow(tie.windows)!.kind).toBe('weekly');
  });

  it('returns null when every window is ok', () => {
    const report = buildBudgetReport({ windows: [input({ kind: 'daily' })] });
    expect(selectStrictestBudgetWindow(report.windows)).toBeNull();
  });
});
