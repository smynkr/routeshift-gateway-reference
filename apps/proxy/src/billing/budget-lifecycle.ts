// Shared RSH-138 budget lifecycle helpers used by both the chat and embeddings
// request handlers. Settlement mutates the shared reservation object so the
// caller's finally gate observes the terminal state.

import type { ServerResponse } from 'node:http';
import { captureException } from '../observability/sentry.js';
import {
  settleBudgetReservation,
  type BudgetAdmissionResult,
  type BudgetReservation,
  type BudgetReservationReasonCode,
} from './budget-reservations.js';

/** Log + capture a budget ledger write failure. The dispatched row is left for
 * lease reclamation into unknown-held — never refunded or released post-dispatch. */
export function reportBudgetLedgerFailure(
  reservation: BudgetReservation | null,
  reasonCode: string,
  err: unknown,
): void {
  if (!reservation) return;
  const message = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({
    event: 'routeshift_budget_ledger_failure',
    request_id: reservation.requestId,
    team_id: reservation.teamId,
    reason_code: reasonCode,
    error: message,
  }));
  captureException(err instanceof Error ? err : new Error(message), {
    tags: { source: 'budget_ledger', reason_code: reasonCode },
    extra: { request_id: reservation.requestId, team_id: reservation.teamId },
  });
}

/** Exact settlement: moves actualMicrocents into period actual and frees the
 * remainder of the estimate. Mutates the shared reservation object. */
export async function settleBudgetExact(
  reservation: BudgetReservation | null,
  actualMicrocents: number,
  reasonCode: BudgetReservationReasonCode,
): Promise<BudgetReservation | null> {
  if (!reservation || reservation.terminal) return reservation;
  try {
    await settleBudgetReservation({
      reservation,
      actualMicrocents,
      actualCostKnown: true,
      reasonCode,
    });
    reservation.terminal = true;
  } catch (err) {
    reportBudgetLedgerFailure(reservation, reasonCode, err);
  }
  return reservation;
}

/** Unknown outcome: hold the unresolved remainder with a recorded lower bound. */
export async function settleBudgetUnknown(
  reservation: BudgetReservation | null,
  lowerBoundMicrocents: number,
  reasonCode: BudgetReservationReasonCode,
): Promise<BudgetReservation | null> {
  if (!reservation || reservation.terminal) return reservation;
  try {
    await settleBudgetReservation({
      reservation,
      actualMicrocents: lowerBoundMicrocents,
      actualCostKnown: false,
      reasonCode,
    });
    reservation.terminal = true;
  } catch (err) {
    reportBudgetLedgerFailure(reservation, reasonCode, err);
  }
  return reservation;
}

/** Write the shared RSH-138 budget rejection contract. Throttle responses carry
 * the exact non-negative Retry-After; hard-cap missing pricing is a 503 with
 * `budget_estimate_unavailable`; reservation/database failures keep the
 * existing 503 'Budget service unavailable' body. */
export function writeBudgetRejection(
  res: ServerResponse,
  admission: Extract<BudgetAdmissionResult, { allowed: false }>,
): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (admission.kind === 'exceeded' && admission.retryAfterSeconds != null) {
    headers['Retry-After'] = String(admission.retryAfterSeconds);
  }
  const body = admission.kind === 'exceeded'
    ? {
        error: {
          message: admission.message,
          window: admission.window,
          reset_at: admission.resetAt,
          scope: admission.scope,
          action: admission.action,
          retry_after: admission.retryAfterSeconds,
        },
      }
    : {
        error: {
          message: admission.message,
          ...(admission.kind === 'estimate_unavailable' ? { code: 'budget_estimate_unavailable' } : {}),
        },
      };
  res.writeHead(admission.statusCode, headers);
  res.end(JSON.stringify(body));
}
