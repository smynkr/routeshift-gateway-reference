/**
 * Pure budget report serializer. Both the proxy reservation service and the
 * dashboard delegate committed arithmetic, status derivation, and precedence
 * to this module — it performs no I/O and imports nothing pg-backed.
 *
 * All arithmetic stays inside Number.isSafeInteger microcent bounds (inputs
 * arrive pre-validated through the shared safe-microcent decoder), and the
 * alert-threshold comparison is performed with BigInt so committed×100 never
 * leaves the exact range.
 */

import type { BudgetAction, BudgetWindowKind } from './budgets';
import { compareBudgetActions } from './budgets';

export interface BudgetWindowLedgerRow {
  kind: BudgetWindowKind;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
  actualMicrocents: number;
  reservedMicrocents: number;
  unknownHeldMicrocents: number;
  unknownCostRequests: number;
}

export interface BudgetWindowInput {
  kind: BudgetWindowKind;
  /** Null when the window has no configured cap for the scope. */
  capMicrocents: number | null;
  /** Configured hard-cap action; null when the window is unconfigured. */
  hardAction: Exclude<BudgetAction, 'ok'> | null;
  /** Soft alert threshold percentage; null when unconfigured. */
  alertAtPct: number | null;
  /** Current period ledger row for this window; null when never touched. */
  ledger: BudgetWindowLedgerRow | null;
  /** True when an unresolved unbounded unknown row gates this scope's hard caps. */
  hasUnboundedUnknown: boolean;
}

export interface BudgetWindowReportEntry {
  kind: BudgetWindowKind;
  capMicrocents: number | null;
  action: Exclude<BudgetAction, 'ok'> | null;
  status: BudgetAction;
  periodStart: string;
  periodEnd: string;
  resetAt: string;
  actualMicrocents: number;
  reservedMicrocents: number;
  unknownHeldMicrocents: number;
  committedMicrocents: number;
  unknownCostRequests: number;
}

export interface SharedBudgetReport {
  windows: BudgetWindowReportEntry[];
  actualCostsQualified: boolean;
}

function alertThresholdReached(committed: number, capMicrocents: number, alertAtPct: number): boolean {
  if (capMicrocents <= 0) return false;
  return BigInt(committed) * 100n >= BigInt(alertAtPct) * BigInt(capMicrocents);
}

export function buildBudgetReport(input: { windows: BudgetWindowInput[] }): SharedBudgetReport {
  let actualCostsQualified = true;
  const windows: BudgetWindowReportEntry[] = [];

  for (const window of input.windows) {
    const actual = window.ledger?.actualMicrocents ?? 0;
    const reserved = window.ledger?.reservedMicrocents ?? 0;
    const unknownHeld = window.ledger?.unknownHeldMicrocents ?? 0;
    const unknownCostRequests = window.ledger?.unknownCostRequests ?? 0;
    if (unknownCostRequests > 0 || window.hasUnboundedUnknown) {
      actualCostsQualified = false;
    }

    const committed = actual + unknownHeld + reserved;
    let status: BudgetAction = 'ok';
    if (window.capMicrocents != null && window.hardAction != null) {
      if (committed > window.capMicrocents || window.hasUnboundedUnknown) {
        // Over cap, or the fail-closed gate is active on an unbounded row.
        status = window.hardAction;
      } else if (
        window.alertAtPct != null &&
        alertThresholdReached(committed, window.capMicrocents, window.alertAtPct)
      ) {
        status = 'alert';
      }
    } else if (window.hasUnboundedUnknown || unknownCostRequests > 0) {
      // Alert-only / uncapped surfaces still flag unresolved unknowns.
      status = 'alert';
    }

    windows.push({
      kind: window.kind,
      capMicrocents: window.capMicrocents,
      action: window.hardAction,
      status,
      periodStart: window.ledger?.periodStart ?? '',
      periodEnd: window.ledger?.periodEnd ?? '',
      resetAt: window.ledger?.resetAt ?? '',
      actualMicrocents: actual,
      reservedMicrocents: reserved,
      unknownHeldMicrocents: unknownHeld,
      committedMicrocents: committed,
      unknownCostRequests,
    });
  }

  return { windows, actualCostsQualified };
}

/**
 * Select the strictest window for a response surface: highest action rank,
 * earliest reset on ties. Returns null when every window is ok.
 */
export function selectStrictestBudgetWindow(
  windows: BudgetWindowReportEntry[],
): BudgetWindowReportEntry | null {
  let winner: BudgetWindowReportEntry | null = null;
  for (const w of windows) {
    if (w.status === 'ok') continue;
    if (winner == null) {
      winner = w;
      continue;
    }
    const rank = compareBudgetActions(w.status, winner.status);
    if (rank > 0 || (rank === 0 && w.resetAt < winner.resetAt)) {
      winner = w;
    }
  }
  return winner;
}
