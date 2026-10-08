import { markStaleCreditReservationsForReconciliation } from './credits.js';

let timer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 5 * 60 * 1000;

/**
 * A deliberately non-financial watchdog. It only promotes abandoned in-flight
 * reservations to an operator-visible state; it never refunds, charges, or
 * resolves a hold based on age.
 */
export function startPendingHoldReconciliationWorker(): void {
  if (timer || process.env.ROUTESHIFT_PENDING_HOLD_WATCHDOG === '0') return;
  const run = async (): Promise<void> => {
    try {
      await markStaleCreditReservationsForReconciliation();
    } catch (error) {
      console.error('[billing] pending-hold reconciliation watchdog failed:', error);
    }
  };
  void run();
  timer = setInterval(() => void run(), POLL_MS);
  timer.unref();
}

export function stopPendingHoldReconciliationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
