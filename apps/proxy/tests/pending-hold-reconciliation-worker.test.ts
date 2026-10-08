import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ markStale: vi.fn(async () => {}) }));

vi.mock('../src/billing/credits.js', () => ({
  markStaleCreditReservationsForReconciliation: mocks.markStale,
}));

import {
  startPendingHoldReconciliationWorker,
  stopPendingHoldReconciliationWorker,
} from '../src/billing/pending-hold-reconciliation-worker.js';

describe('pending hold reconciliation worker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete process.env.ROUTESHIFT_PENDING_HOLD_WATCHDOG;
    stopPendingHoldReconciliationWorker();
  });

  afterEach(() => {
    stopPendingHoldReconciliationWorker();
    vi.useRealTimers();
    delete process.env.ROUTESHIFT_PENDING_HOLD_WATCHDOG;
  });

  it('runs immediately and on its default five-minute interval', async () => {
    startPendingHoldReconciliationWorker();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.markStale).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(mocks.markStale).toHaveBeenCalledTimes(2);
  });

  it('does not start when the watchdog kill switch is disabled', async () => {
    process.env.ROUTESHIFT_PENDING_HOLD_WATCHDOG = '0';

    startPendingHoldReconciliationWorker();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(mocks.markStale).not.toHaveBeenCalled();
  });

  it('does not create a second interval when started repeatedly', async () => {
    startPendingHoldReconciliationWorker();
    startPendingHoldReconciliationWorker();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(mocks.markStale).toHaveBeenCalledTimes(2);
  });

  it('stops future reconciliation polls', async () => {
    startPendingHoldReconciliationWorker();
    await vi.advanceTimersByTimeAsync(0);
    stopPendingHoldReconciliationWorker();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(mocks.markStale).toHaveBeenCalledTimes(1);
  });
});
