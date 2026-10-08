import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  addCredits: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
  }),
}));

vi.mock('../src/billing/credits.js', () => ({
  addCredits: mocks.addCredits,
}));

vi.mock('../src/observability/sentry.js', () => ({
  captureException: mocks.captureException,
}));

import {
  AMBIGUOUS_ATTEMPT_REPLAY_CUTOFF_MS,
  AUTO_TOP_UP_SAFETY_LIMITS,
  evaluateAutoTopUpLimits,
  getAutoTopUpWorkerMode,
  isRetryableTopUpError,
  processQueue,
  processTeamTopUp,
  startAutoTopUpWorker,
  stopAutoTopUpWorker,
} from '../src/billing/auto-topup-worker.js';

const MICROCENTS_PER_CENT = 1_000_000;

describe('auto-topup durable schema', () => {
  it('uses TEXT tenant ids, a stable attempt key, and a fail-closed disable state', () => {
    const migration = readFileSync(
      new URL('../src/db/migrations/049-auto-topup-attempts.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('team_id TEXT NOT NULL');
    expect(migration).not.toMatch(/team_id\s+uuid/i);
    expect(migration).toContain('idempotency_key TEXT NOT NULL UNIQUE');
    expect(migration).toContain('amount_microcents = amount_cents * 1000000');
    expect(migration).toContain('auto_topup_settings_disabled_state_check');
    expect(migration).toContain('stripe_customer_id TEXT NOT NULL');
    expect(migration).toContain('stripe_payment_method_id TEXT NOT NULL');
    expect(migration).toContain('submitted_at TIMESTAMPTZ');
    expect(migration).toContain("'reconciliation_required'");
    expect(migration).toContain("WHERE status IN ('pending', 'charged', 'reconciliation_required')");
  });
});

describe('auto-topup worker mode fence', () => {
  const originalKey = process.env.STRIPE_SECRET_KEY;
  const originalMode = process.env.AUTO_TOPUP_WORKER_MODE;

  beforeEach(() => {
    stopAutoTopUpWorker();
    vi.useFakeTimers();
    process.env.STRIPE_SECRET_KEY = 'sk_test_not_real';
  });

  afterEach(() => {
    stopAutoTopUpWorker();
    vi.useRealTimers();
    if (originalKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalKey;
    if (originalMode === undefined) delete process.env.AUTO_TOPUP_WORKER_MODE;
    else process.env.AUTO_TOPUP_WORKER_MODE = originalMode;
  });

  it('fails closed for absent, invalid, and explicit off modes', () => {
    expect(getAutoTopUpWorkerMode(undefined)).toBe('off');
    expect(getAutoTopUpWorkerMode('invalid')).toBe('off');
    for (const mode of [undefined, 'invalid', 'off']) {
      if (mode === undefined) delete process.env.AUTO_TOPUP_WORKER_MODE;
      else process.env.AUTO_TOPUP_WORKER_MODE = mode;
      startAutoTopUpWorker();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it.each(['legacy', 'durable'] as const)('starts exactly one %s worker timer', (mode) => {
    process.env.AUTO_TOPUP_WORKER_MODE = mode;
    startAutoTopUpWorker();
    expect(getAutoTopUpWorkerMode()).toBe(mode);
    expect(vi.getTimerCount()).toBe(1);
  });
});

function stripeWithCreate(create: ReturnType<typeof vi.fn>): Stripe {
  return { paymentIntents: { create } } as unknown as Stripe;
}

describe('auto-topup safety limits', () => {
  const planned = 1_000 * MICROCENTS_PER_CENT;

  it('allows a charge that lands exactly on the UTC daily/monthly boundary', () => {
    expect(evaluateAutoTopUpLimits({
      dailyGrossMicrocents: AUTO_TOP_UP_SAFETY_LIMITS.dailyCapMicrocents - planned,
      monthlyGrossMicrocents: AUTO_TOP_UP_SAFETY_LIMITS.monthlyCapMicrocents - planned,
      velocitySuccessfulTopUps: 0,
    }, planned)).toBeUndefined();
  });

  it('returns exact daily, monthly, and combined denial reasons one microcent over', () => {
    expect(evaluateAutoTopUpLimits({
      dailyGrossMicrocents: AUTO_TOP_UP_SAFETY_LIMITS.dailyCapMicrocents - planned + 1,
      monthlyGrossMicrocents: 0,
      velocitySuccessfulTopUps: 0,
    }, planned)).toBe('daily_cap_exceeded');

    expect(evaluateAutoTopUpLimits({
      dailyGrossMicrocents: 0,
      monthlyGrossMicrocents: AUTO_TOP_UP_SAFETY_LIMITS.monthlyCapMicrocents - planned + 1,
      velocitySuccessfulTopUps: 0,
    }, planned)).toBe('monthly_cap_exceeded');

    expect(evaluateAutoTopUpLimits({
      dailyGrossMicrocents: AUTO_TOP_UP_SAFETY_LIMITS.dailyCapMicrocents,
      monthlyGrossMicrocents: AUTO_TOP_UP_SAFETY_LIMITS.monthlyCapMicrocents,
      velocitySuccessfulTopUps: 0,
    }, planned)).toBe('daily_and_monthly_caps_exceeded');
  });

  it('trips the short-window successful-charge velocity breaker', () => {
    expect(evaluateAutoTopUpLimits({
      dailyGrossMicrocents: 0,
      monthlyGrossMicrocents: 0,
      velocitySuccessfulTopUps: AUTO_TOP_UP_SAFETY_LIMITS.velocityMaxSuccessfulTopUps,
    }, planned)).toBe('topup_velocity_exceeded');
  });
});

describe('isRetryableTopUpError', () => {
  it('retries transient Stripe failures and non-Stripe throws', () => {
    expect(isRetryableTopUpError(new Stripe.errors.StripeConnectionError({ message: 'conn reset' }))).toBe(true);
    expect(isRetryableTopUpError(new Stripe.errors.StripeAPIError({ message: 'stripe 500' }))).toBe(true);
    expect(isRetryableTopUpError(new Stripe.errors.StripeRateLimitError({ message: 'rate limited' }))).toBe(true);
    expect(isRetryableTopUpError(new Error('db blip'))).toBe(true);
  });

  it('does not retry hard declines or configuration errors', () => {
    expect(isRetryableTopUpError(new Stripe.errors.StripeCardError({ message: 'card_declined' }))).toBe(false);
    expect(isRetryableTopUpError(new Stripe.errors.StripeInvalidRequestError({ message: 'bad params' }))).toBe(false);
    expect(isRetryableTopUpError(new Stripe.errors.StripeAuthenticationError({ message: 'bad api key' }))).toBe(false);
  });
});

describe('processTeamTopUp money-safety path', () => {
  let activeAttempt: {
    id: string;
    idempotency_key: string;
    amount_cents: number;
    stripe_customer_id: string;
    stripe_payment_method_id: string;
    payment_intent_id: string | null;
    submitted_at: string | null;
    status: 'pending' | 'charged' | 'reconciliation_required';
  } | undefined;
  let usage = {
    daily_gross_microcents: 0,
    monthly_gross_microcents: 0,
    velocity_successful_topups: 0,
  };
  let lockAcquired = true;
  let grossSql = '';
  let disabledReason: string | undefined;
  let failedAttempt = false;
  let settlementError: Error | undefined;
  let rollbackError: Error | undefined;

  const pool = {
    connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    activeAttempt = undefined;
    usage = {
      daily_gross_microcents: 0,
      monthly_gross_microcents: 0,
      velocity_successful_topups: 0,
    };
    lockAcquired = true;
    grossSql = '';
    disabledReason = undefined;
    failedAttempt = false;
    settlementError = undefined;
    rollbackError = undefined;
    mocks.addCredits.mockResolvedValue(25_000_000);
    mocks.clientQuery.mockImplementation(async (sqlValue: string, params?: unknown[]) => {
      const sql = String(sqlValue);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: lockAcquired }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
      if (sql.includes('FROM auto_topup_settings') && sql.includes('enabled = true')) {
        return { rows: [{ reload_amount_cents: 2500, stripe_payment_method_id: 'pm_secret', last_topup_at: null }] };
      }
      if (sql.includes("status IN ('pending', 'charged', 'reconciliation_required')") && sql.includes('FROM auto_topup_attempts')) {
        return { rows: activeAttempt ? [activeAttempt] : [] };
      }
      if (sql.includes('WITH gross_successful_charges')) {
        grossSql = sql;
        return { rows: [usage] };
      }
      if (sql.includes('SELECT stripe_customer_id FROM teams')) {
        return { rows: [{ stripe_customer_id: 'cus_secret' }] };
      }
      if (sql.includes('INSERT INTO auto_topup_attempts')) {
        activeAttempt = {
          id: String(params?.[0]),
          idempotency_key: String(params?.[2]),
          amount_cents: Number(params?.[3]),
          stripe_customer_id: String(params?.[5]),
          stripe_payment_method_id: String(params?.[6]),
          payment_intent_id: null,
          submitted_at: null,
          status: 'pending',
        };
        return { rows: [activeAttempt] };
      }
      if (sql.includes('SET submitted_at = COALESCE')) {
        activeAttempt = { ...activeAttempt!, submitted_at: new Date().toISOString() };
        return { rows: [] };
      }
      if (sql.includes("SET status = 'reconciliation_required'")) {
        activeAttempt = { ...activeAttempt!, status: 'reconciliation_required' };
        return { rows: [] };
      }
      if (sql.includes("SET status = 'charged'")) {
        activeAttempt = {
          ...activeAttempt!,
          payment_intent_id: String(params?.[1]),
          status: 'charged',
        };
        return { rows: [] };
      }
      if (sql.includes("SET status = 'failed'")) {
        failedAttempt = true;
        activeAttempt = undefined;
        return { rows: [] };
      }
      if (sql.includes("SET status = 'settled'")) {
        activeAttempt = undefined;
        return { rows: [] };
      }
      if (sql.includes('SET enabled = false, disabled_reason')) {
        disabledReason = String(params?.[1]);
        return { rows: [] };
      }
      if (sql.includes('SET last_topup_at = now()') && settlementError) throw settlementError;
      if (sql === 'ROLLBACK' && rollbackError) throw rollbackError;
      return { rows: [] };
    });
  });

  it('uses gross PaymentIntent/legacy charge sources and preserves microcent units', async () => {
    // This gross amount can come from a reversal-before-credit parent. Refund,
    // dispute, and reinstatement state is intentionally absent from the query,
    // so none of them can lower the successful Stripe charge total.
    usage.daily_gross_microcents = 20_000 * MICROCENTS_PER_CENT;
    usage.monthly_gross_microcents = 20_000 * MICROCENTS_PER_CENT;
    const create = vi.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded' });

    await processTeamTopUp(pool, stripeWithCreate(create), 'team_1');

    expect(grossSql).toContain('FROM credit_payment_intents');
    expect(grossSql).toContain('FROM credit_transactions');
    expect(grossSql).toContain("p.credit_kind = 'auto_topup'");
    expect(grossSql).toContain("t.type = 'auto_topup'");
    expect(grossSql).toContain('MAX(t.amount_microcents)');
    expect(grossSql).toContain('GROUP BY COALESCE(t.idempotency_key, t.reference_id, t.id)');
    expect(grossSql).toContain("date_trunc('day'");
    expect(grossSql).toContain("date_trunc('month'");
    expect(grossSql).not.toContain('credit_payment_reversals');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2500 }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^autotopup:team_1:atu_/) }),
    );
    expect(mocks.addCredits).toHaveBeenCalledWith('team_1', 2500, 'auto_topup', 'pi_1', 'pi_1');
  });

  it('serializes concurrent workers with a per-team session advisory lock', async () => {
    lockAcquired = false;
    const create = vi.fn();

    await processTeamTopUp(pool, stripeWithCreate(create), 'team_1');

    expect(create).not.toHaveBeenCalled();
    expect(mocks.addCredits).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('disables with the exact non-sensitive cap reason and emits structured alert evidence', async () => {
    usage.daily_gross_microcents = AUTO_TOP_UP_SAFETY_LIMITS.dailyCapMicrocents;
    const create = vi.fn();

    await processTeamTopUp(pool, stripeWithCreate(create), 'team_1');

    expect(disabledReason).toBe('daily_cap_exceeded');
    expect(create).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'auto_topup_disabled:daily_cap_exceeded' }),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'daily_cap_exceeded' }) }),
    );
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain('pm_secret');
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain('cus_secret');
  });

  it('reuses one durable Stripe idempotency key after an ambiguous transient failure', async () => {
    const create = vi.fn()
      .mockRejectedValueOnce(new Stripe.errors.StripeConnectionError({ message: 'connection reset' }))
      .mockResolvedValueOnce({ id: 'pi_replayed', status: 'succeeded' });
    const stripe = stripeWithCreate(create);

    await expect(processTeamTopUp(pool, stripe, 'team_1')).rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError);
    const reservedKey = activeAttempt?.idempotency_key;
    expect(reservedKey).toMatch(/^autotopup:team_1:atu_/);

    await processTeamTopUp(pool, stripe, 'team_1');

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[1]).toEqual({ idempotencyKey: reservedKey });
    expect(create.mock.calls[1]?.[1]).toEqual({ idempotencyKey: reservedKey });
    expect(mocks.addCredits).toHaveBeenCalledOnce();
  });

  it('fails closed instead of replaying an ambiguous attempt beyond the Stripe retention cutoff', async () => {
    activeAttempt = {
      id: 'atu_expired',
      idempotency_key: 'autotopup:team_1:atu_expired',
      amount_cents: 2500,
      stripe_customer_id: 'cus_original',
      stripe_payment_method_id: 'pm_original',
      payment_intent_id: null,
      submitted_at: new Date(Date.now() - AMBIGUOUS_ATTEMPT_REPLAY_CUTOFF_MS).toISOString(),
      status: 'pending',
    };
    const create = vi.fn();

    await processTeamTopUp(pool, stripeWithCreate(create), 'team_1');

    expect(create).not.toHaveBeenCalled();
    expect(activeAttempt.status).toBe('reconciliation_required');
    expect(disabledReason).toBe('ambiguous_attempt_expired');
  });

  it('replays immutable customer and payment-method parameters after settings change', async () => {
    activeAttempt = {
      id: 'atu_pending',
      idempotency_key: 'autotopup:team_1:atu_pending',
      amount_cents: 2500,
      stripe_customer_id: 'cus_original',
      stripe_payment_method_id: 'pm_original',
      payment_intent_id: null,
      submitted_at: new Date().toISOString(),
      status: 'pending',
    };
    const create = vi.fn().mockResolvedValue({ id: 'pi_original', status: 'succeeded' });

    await processTeamTopUp(pool, stripeWithCreate(create), 'team_1');

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_original', payment_method: 'pm_original' }),
      { idempotencyKey: 'autotopup:team_1:atu_pending' },
    );
  });

  it('settles a previously charged attempt without creating another PaymentIntent', async () => {
    activeAttempt = {
      id: 'atu_existing',
      idempotency_key: 'autotopup:team_1:atu_existing',
      amount_cents: 2500,
      stripe_customer_id: 'cus_original',
      stripe_payment_method_id: 'pm_original',
      payment_intent_id: 'pi_existing',
      submitted_at: new Date().toISOString(),
      status: 'charged',
    };
    const create = vi.fn();

    await processTeamTopUp(pool, stripeWithCreate(create), 'team_1');

    expect(create).not.toHaveBeenCalled();
    expect(mocks.addCredits).toHaveBeenCalledWith(
      'team_1', 2500, 'auto_topup', 'pi_existing', 'pi_existing',
    );
  });

  it('reports rollback failure safely and preserves the original settlement error', async () => {
    activeAttempt = {
      id: 'atu_charged',
      idempotency_key: 'autotopup:team_1:atu_charged',
      amount_cents: 2500,
      stripe_customer_id: 'cus_secret',
      stripe_payment_method_id: 'pm_secret',
      payment_intent_id: 'pi_secret',
      submitted_at: new Date().toISOString(),
      status: 'charged',
    };
    settlementError = new Error('settlement failed');
    rollbackError = new Error('rollback failed');

    await expect(processTeamTopUp(pool, stripeWithCreate(vi.fn()), 'team_1'))
      .rejects.toBe(settlementError);

    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'auto_topup_settlement_rollback_failed' }),
      expect.objectContaining({
        tags: { source: 'auto_topup_worker', stage: 'settlement_rollback', errorType: 'Error' },
      }),
    );
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain('pm_secret');
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain('cus_secret');
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain('pi_secret');
  });

  it('closes a hard-decline attempt so corrected payment settings can use a fresh key later', async () => {
    const create = vi.fn().mockRejectedValue(
      new Stripe.errors.StripeCardError({ message: 'card declined' }),
    );

    await expect(processTeamTopUp(pool, stripeWithCreate(create), 'team_1'))
      .rejects.toBeInstanceOf(Stripe.errors.StripeCardError);

    expect(failedAttempt).toBe(true);
    expect(activeAttempt).toBeUndefined();
    expect(mocks.addCredits).not.toHaveBeenCalled();
  });
});

describe('processQueue retry discipline', () => {
  let queue: string[];
  let insertedTeams: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    queue = ['team_1'];
    insertedTeams = [];
    mocks.poolQuery.mockImplementation(async (sqlValue: string, params?: unknown[]) => {
      const sql = String(sqlValue);
      if (sql.includes('DELETE FROM auto_topup_queue')) {
        const team = queue.shift();
        return team ? { rows: [{ team_id: team }] } : { rows: [] };
      }
      if (sql.includes('INSERT INTO auto_topup_queue')) {
        const team = String(params?.[0]);
        insertedTeams.push(team);
        if (!queue.includes(team)) queue.push(team);
      }
      return { rows: [] };
    });
    mocks.clientQuery.mockImplementation(async (sqlValue: string) => {
      const sql = String(sqlValue);
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
      if (sql.includes('FROM auto_topup_settings')) {
        return { rows: [{ reload_amount_cents: 1000, stripe_payment_method_id: 'pm_1', last_topup_at: null }] };
      }
      if (sql.includes('WITH gross_successful_charges')) {
        return { rows: [{ daily_gross_microcents: 0, monthly_gross_microcents: 0, velocity_successful_topups: 0 }] };
      }
      if (sql.includes('FROM auto_topup_attempts')) return { rows: [] };
      if (sql.includes('FROM teams')) return { rows: [{ stripe_customer_id: 'cus_1' }] };
      if (sql.includes('INSERT INTO auto_topup_attempts')) {
        return { rows: [{
          id: 'atu_1',
          idempotency_key: 'autotopup:team_1:atu_1',
          amount_cents: 1000,
          stripe_customer_id: 'cus_1',
          stripe_payment_method_id: 'pm_1',
          payment_intent_id: null,
          submitted_at: null,
          status: 'pending',
        }] };
      }
      return { rows: [] };
    });
  });

  it('re-enqueues a transient failure once after the drain, never in the same drain', async () => {
    const create = vi.fn().mockRejectedValue(
      new Stripe.errors.StripeConnectionError({ message: 'connection reset' }),
    );

    await processQueue(stripeWithCreate(create));

    expect(create).toHaveBeenCalledOnce();
    expect(insertedTeams).toEqual(['team_1']);
    expect(queue).toEqual(['team_1']);
  });

  it('does not re-enqueue a hard card decline', async () => {
    const create = vi.fn().mockRejectedValue(
      new Stripe.errors.StripeCardError({ message: 'Your card was declined.' }),
    );

    await processQueue(stripeWithCreate(create));

    expect(create).toHaveBeenCalledOnce();
    expect(insertedTeams).toEqual([]);
    expect(queue).toEqual([]);
  });

  it('keeps hard ceilings active in legacy rollback mode', async () => {
    let claimed = false;
    let disabledReason: string | undefined;
    mocks.poolQuery.mockImplementation(async (sqlValue: string, params?: unknown[]) => {
      const sql = String(sqlValue);
      if (sql.includes('DELETE FROM auto_topup_queue')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ team_id: 'team_1' }] };
      }
      if (sql.includes('FROM auto_topup_settings')) {
        return { rows: [{ reload_amount_cents: 2500, stripe_payment_method_id: 'pm_1', last_topup_at: null }] };
      }
      if (sql.includes('FROM credit_transactions')) {
        return { rows: [{
          daily_gross_microcents: AUTO_TOP_UP_SAFETY_LIMITS.dailyCapMicrocents,
          monthly_gross_microcents: AUTO_TOP_UP_SAFETY_LIMITS.monthlyCapMicrocents,
          velocity_successful_topups: 0,
        }] };
      }
      if (sql.includes('SET enabled = false, disabled_reason')) {
        disabledReason = String(params?.[1]);
      }
      return { rows: [] };
    });
    const create = vi.fn();

    await processQueue(stripeWithCreate(create), 'legacy');

    expect(create).not.toHaveBeenCalled();
    expect(disabledReason).toBe('daily_and_monthly_caps_exceeded');
  });
});
