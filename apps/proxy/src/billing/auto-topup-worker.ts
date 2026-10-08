import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { captureException } from '../observability/sentry.js';
import { addCredits } from './credits.js';

let timer: ReturnType<typeof setInterval> | null = null;

const MICROCENTS_PER_CENT = 1_000_000;
const COOLDOWN_MS = 5 * 60 * 1000;
export const AMBIGUOUS_ATTEMPT_REPLAY_CUTOFF_MS = 23 * 60 * 60 * 1000;

export type AutoTopUpWorkerMode = 'legacy' | 'off' | 'durable';

export function getAutoTopUpWorkerMode(value = process.env.AUTO_TOPUP_WORKER_MODE): AutoTopUpWorkerMode {
  if (value === 'legacy' || value === 'off' || value === 'durable') return value;
  return 'off';
}

/**
 * Server-owned money-safety contract. These limits are deliberately not
 * customer-writable: raising an automatic-charge ceiling requires a reviewed
 * code change. A single charge remains bounded by the dashboard's existing
 * $10-$500 contract; these limits only add cumulative circuit breakers.
 */
export const AUTO_TOP_UP_SAFETY_LIMITS = Object.freeze({
  dailyCapMicrocents: 50_000 * MICROCENTS_PER_CENT,
  monthlyCapMicrocents: 200_000 * MICROCENTS_PER_CENT,
  velocityWindowMinutes: 15,
  velocityMaxSuccessfulTopUps: 2,
});

export type AutoTopUpDenialReason =
  | 'daily_cap_exceeded'
  | 'monthly_cap_exceeded'
  | 'daily_and_monthly_caps_exceeded'
  | 'topup_velocity_exceeded';

type AutoTopUpDisableReason = AutoTopUpDenialReason | 'ambiguous_attempt_expired';

export interface AutoTopUpUsage {
  dailyGrossMicrocents: number;
  monthlyGrossMicrocents: number;
  velocitySuccessfulTopUps: number;
}

export function evaluateAutoTopUpLimits(
  usage: AutoTopUpUsage,
  plannedMicrocents: number,
): AutoTopUpDenialReason | undefined {
  const dailyExceeded = usage.dailyGrossMicrocents + plannedMicrocents
    > AUTO_TOP_UP_SAFETY_LIMITS.dailyCapMicrocents;
  const monthlyExceeded = usage.monthlyGrossMicrocents + plannedMicrocents
    > AUTO_TOP_UP_SAFETY_LIMITS.monthlyCapMicrocents;
  if (dailyExceeded && monthlyExceeded) return 'daily_and_monthly_caps_exceeded';
  if (dailyExceeded) return 'daily_cap_exceeded';
  if (monthlyExceeded) return 'monthly_cap_exceeded';
  if (
    usage.velocitySuccessfulTopUps
    >= AUTO_TOP_UP_SAFETY_LIMITS.velocityMaxSuccessfulTopUps
  ) {
    return 'topup_velocity_exceeded';
  }
  return undefined;
}

export function startAutoTopUpWorker(): void {
  const mode = getAutoTopUpWorkerMode();
  if (mode === 'off') {
    console.log('[auto-topup] Worker disabled (AUTO_TOPUP_WORKER_MODE=off or invalid/unset)');
    return;
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.log('[auto-topup] STRIPE_SECRET_KEY not set — worker disabled');
    return;
  }

  const stripe = new Stripe(stripeKey, {
    apiVersion: '2026-02-25.clover',
  });

  console.log(`[auto-topup] ${mode} worker started (polling every 10s)`);
  timer = setInterval(() => processQueue(stripe, mode), 10_000);
  timer.unref();
}

export function stopAutoTopUpWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Re-enqueue ONLY on transient failures. Stripe's typed errors classify them:
// connection / API (5xx) / rate-limit are retryable, as is any non-Stripe throw
// (e.g. a transient DB error before the charge). A card decline, invalid-request,
// auth, permission or idempotency error will never succeed on retry and would
// hot-loop the 10s poller, so those intentionally drop out of the queue — the
// team must fix their card/settings, and the next preflight 402 re-enqueues them.
export function isRetryableTopUpError(err: unknown): boolean {
  if (
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err instanceof Stripe.errors.StripeRateLimitError
  ) {
    return true;
  }
  if (err instanceof Stripe.errors.StripeError) return false;
  return true;
}

export async function processQueue(
  stripe: Stripe,
  mode: Exclude<AutoTopUpWorkerMode, 'off'> = 'durable',
): Promise<void> {
  const pool = getPool();
  // Teams whose charge failed transiently. We re-enqueue them AFTER the drain,
  // never inside the loop: re-inserting mid-drain lets the very next DELETE
  // reclaim the same row, so a persistent transient error (Stripe outage / rate
  // limit / DB blip) would spin in a tight loop hammering Stripe + Postgres
  // instead of waiting for the next 10s poll. Deferring bounds retries to the
  // poll interval.
  const retryTeams: string[] = [];
  try {
    while (true) {
      const { rows } = await pool.query(
        `DELETE FROM auto_topup_queue
         WHERE team_id = (
           SELECT team_id FROM auto_topup_queue LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING team_id`,
      );

      if (rows.length === 0) break;

      const { team_id } = rows[0];
      try {
        if (mode === 'legacy') {
          await processLegacyTeamTopUp(pool, stripe, team_id as string);
        } else {
          await processTeamTopUp(pool, stripe, team_id as string);
        }
      } catch (err) {
        console.error(`[auto-topup] Failed for team ${team_id}:`, err);
        // The claiming DELETE already removed this row; re-arm transient failures
        // (hard declines / config errors are dropped — they can't succeed on
        // retry and would otherwise re-queue forever).
        if (isRetryableTopUpError(err)) retryTeams.push(team_id as string);
      }
    }
  } catch (err) {
    console.error('[auto-topup] Queue processing error:', err);
  }

  // Re-arm transient failures once, after the drain has fully completed — they
  // are picked up on the next poll and never reprocessed by this drain.
  // Idempotent via the auto_topup_queue team_id primary key.
  for (const team_id of retryTeams) {
    await pool
      .query(`INSERT INTO auto_topup_queue (team_id) VALUES ($1) ON CONFLICT DO NOTHING`, [team_id])
      .catch((reErr) => console.error(`[auto-topup] Re-enqueue failed for team ${team_id}:`, reErr));
  }
}

type AutoTopUpDbClient = Pick<PoolClient, 'query' | 'release'>;

interface AttemptRow {
  id: string;
  idempotency_key: string;
  amount_cents: number | string;
  stripe_customer_id: string;
  stripe_payment_method_id: string;
  payment_intent_id: string | null;
  submitted_at: string | Date | null;
  status: 'pending' | 'charged' | 'reconciliation_required';
}

interface GrossUsageRow {
  daily_gross_microcents: number | string;
  monthly_gross_microcents: number | string;
  velocity_successful_topups: number | string;
}

async function disableAutoTopUp(
  client: AutoTopUpDbClient,
  teamId: string,
  reason: AutoTopUpDisableReason,
): Promise<void> {
  await client.query(
    `UPDATE auto_topup_settings
     SET enabled = false, disabled_reason = $2, disabled_at = now(), updated_at = now()
     WHERE team_id = $1`,
    [teamId, reason],
  );
  console.error(`[auto-topup] Disabled team ${teamId}: ${reason}`);
  captureException(new Error(`auto_topup_disabled:${reason}`), {
    tags: { source: 'auto_topup_worker', reason },
    extra: { teamId },
  });
}

async function getGrossUsage(
  client: AutoTopUpDbClient,
  teamId: string,
): Promise<AutoTopUpUsage> {
  const { rows } = await client.query<GrossUsageRow>(
    `WITH gross_successful_charges AS (
       -- Durable RSH-92 attempts are the primary source for new charges. A
       -- pending attempt counts at its planned gross amount so an ambiguous
       -- Stripe response fails closed until the same idempotency key resolves.
       SELECT a.payment_intent_id AS charge_id,
              a.amount_microcents,
              COALESCE(a.charged_at, a.created_at) AS charged_at,
              a.status <> 'pending' AS succeeded
       FROM auto_topup_attempts a
       WHERE a.team_id = $1 AND a.status IN ('pending', 'charged', 'settled')

       UNION ALL

       -- credit_payment_intents stores Stripe's original gross amount. Refund,
       -- dispute and reinstatement rows never reduce it. Exclude attempts to
       -- avoid double-counting the same PaymentIntent after settlement.
       SELECT p.payment_intent_id,
              p.amount_microcents,
              p.created_at,
              true
       FROM credit_payment_intents p
       WHERE p.team_id = $1
         AND p.credit_kind = 'auto_topup'
         AND NOT EXISTS (
           SELECT 1 FROM auto_topup_attempts a
           WHERE a.payment_intent_id = p.payment_intent_id
         )

       UNION ALL

       -- Pre-migration successful topups may exist only in the ledger. Grouping
       -- by the legacy reference/idempotency key makes retries count once, and
       -- excluding parent/attempt rows keeps newer charges single-counted.
       SELECT COALESCE(t.idempotency_key, t.reference_id, t.id) AS charge_id,
              MAX(t.amount_microcents) AS amount_microcents,
              MIN(t.created_at) AS charged_at,
              true
       FROM credit_transactions t
       WHERE t.team_id = $1
         AND t.type = 'auto_topup'
         AND t.amount_microcents > 0
         AND NOT EXISTS (
           SELECT 1 FROM credit_payment_intents p
           WHERE p.payment_intent_id = COALESCE(t.idempotency_key, t.reference_id)
         )
         AND NOT EXISTS (
           SELECT 1 FROM auto_topup_attempts a
           WHERE a.payment_intent_id = COALESCE(t.idempotency_key, t.reference_id)
              OR a.idempotency_key = t.idempotency_key
         )
       GROUP BY COALESCE(t.idempotency_key, t.reference_id, t.id)
     )
     SELECT
       COALESCE(SUM(amount_microcents) FILTER (
         WHERE charged_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       ), 0) AS daily_gross_microcents,
       COALESCE(SUM(amount_microcents) FILTER (
         WHERE charged_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       ), 0) AS monthly_gross_microcents,
       COUNT(*) FILTER (
         WHERE succeeded
           AND charged_at >= now() - ($2 * interval '1 minute')
       ) AS velocity_successful_topups
     FROM gross_successful_charges`,
    [teamId, AUTO_TOP_UP_SAFETY_LIMITS.velocityWindowMinutes],
  );
  const usage = rows[0];
  if (!usage) throw new Error('auto-topup gross usage query returned no row');
  const result = {
    dailyGrossMicrocents: Number(usage.daily_gross_microcents),
    monthlyGrossMicrocents: Number(usage.monthly_gross_microcents),
    velocitySuccessfulTopUps: Number(usage.velocity_successful_topups),
  };
  if (!Object.values(result).every(Number.isSafeInteger)) {
    throw new Error('auto-topup gross usage query returned unsafe values');
  }
  return result;
}

async function processLegacyTeamTopUp(
  pool: ReturnType<typeof getPool>,
  stripe: Stripe,
  teamId: string,
): Promise<void> {
  const { rows: settingsRows } = await pool.query(
    `SELECT reload_amount_cents, stripe_payment_method_id, last_topup_at
     FROM auto_topup_settings
     WHERE team_id = $1 AND enabled = true`,
    [teamId],
  );
  const settings = settingsRows[0];
  if (!settings?.stripe_payment_method_id) return;
  if (
    settings.last_topup_at
    && Date.now() - new Date(settings.last_topup_at).getTime() < COOLDOWN_MS
  ) return;

  const reloadAmountCents = Number(settings.reload_amount_cents);
  if (!Number.isSafeInteger(reloadAmountCents) || reloadAmountCents < 1_000 || reloadAmountCents > 50_000) {
    throw new Error('auto-topup reload amount is outside the safe per-charge contract');
  }
  const { rows: usageRows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount_microcents) FILTER (
         WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       ), 0) AS daily_gross_microcents,
       COALESCE(SUM(amount_microcents) FILTER (
         WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       ), 0) AS monthly_gross_microcents,
       COUNT(*) FILTER (
         WHERE created_at >= now() - ($2 * interval '1 minute')
       ) AS velocity_successful_topups
     FROM credit_transactions
     WHERE team_id = $1 AND type = 'auto_topup' AND amount_microcents > 0`,
    [teamId, AUTO_TOP_UP_SAFETY_LIMITS.velocityWindowMinutes],
  );
  const usage = usageRows[0];
  const denialReason = evaluateAutoTopUpLimits({
    dailyGrossMicrocents: Number(usage?.daily_gross_microcents ?? 0),
    monthlyGrossMicrocents: Number(usage?.monthly_gross_microcents ?? 0),
    velocitySuccessfulTopUps: Number(usage?.velocity_successful_topups ?? 0),
  }, reloadAmountCents * MICROCENTS_PER_CENT);
  if (denialReason) {
    await pool.query(
      `UPDATE auto_topup_settings
       SET enabled = false, disabled_reason = $2, disabled_at = now(), updated_at = now()
       WHERE team_id = $1`,
      [teamId, denialReason],
    );
    return;
  }

  const { rows: teamRows } = await pool.query(
    'SELECT stripe_customer_id FROM teams WHERE id = $1',
    [teamId],
  );
  const stripeCustomerId = teamRows[0]?.stripe_customer_id;
  if (!stripeCustomerId) return;

  const idempotencyKey = `autotopup:${teamId}:${Math.floor(Date.now() / COOLDOWN_MS)}`;
  const pi = await stripe.paymentIntents.create({
    amount: reloadAmountCents,
    currency: 'usd',
    customer: stripeCustomerId,
    payment_method: settings.stripe_payment_method_id,
    confirm: true,
    off_session: true,
    metadata: { type: 'auto_topup', team_id: teamId },
  }, { idempotencyKey });
  if (pi.status !== 'succeeded') return;

  await addCredits(
    teamId,
    reloadAmountCents,
    'auto_topup',
    pi.id,
    pi.id,
  );
  await pool.query(
    'UPDATE auto_topup_settings SET last_topup_at = now() WHERE team_id = $1',
    [teamId],
  );
}

export async function processTeamTopUp(
  pool: Pick<Pool, 'connect'>,
  stripe: Stripe,
  teamId: string,
): Promise<void> {
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    const { rows: lockRows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('auto_topup:' || $1)) AS acquired`,
      [teamId],
    );
    lockAcquired = Boolean(lockRows[0]?.acquired);
    if (!lockAcquired) return;

    // 1. Check auto-topup settings while holding the cross-replica team lock.
    const { rows: settingsRows } = await client.query(
      `SELECT reload_amount_cents, stripe_payment_method_id, last_topup_at
       FROM auto_topup_settings
       WHERE team_id = $1 AND enabled = true`,
      [teamId],
    );

    if (settingsRows.length === 0) return;
    const settings = settingsRows[0];

    if (!settings.stripe_payment_method_id) return;

    // 2. Preserve the existing five-minute cooldown.
    if (settings.last_topup_at) {
      const elapsed = Date.now() - new Date(settings.last_topup_at).getTime();
      if (elapsed < COOLDOWN_MS) return;
    }

    const reloadAmountCents = Number(settings.reload_amount_cents);
    if (!Number.isSafeInteger(reloadAmountCents) || reloadAmountCents < 1_000 || reloadAmountCents > 50_000) {
      throw new Error('auto-topup reload amount is outside the safe per-charge contract');
    }
    const plannedMicrocents = reloadAmountCents * MICROCENTS_PER_CENT;

    // 2.5 Reuse an unresolved attempt before considering a new charge. This is
    // what keeps one Stripe idempotency key stable across crashes and retries.
    const { rows: attemptRows } = await client.query<AttemptRow>(
      `SELECT id, idempotency_key, amount_cents, stripe_customer_id,
              stripe_payment_method_id, payment_intent_id, submitted_at, status
       FROM auto_topup_attempts
       WHERE team_id = $1 AND status IN ('pending', 'charged', 'reconciliation_required')
       ORDER BY created_at
       LIMIT 1`,
      [teamId],
    );
    let attempt = attemptRows[0];

    if (attempt?.status === 'reconciliation_required') return;
    if (
      attempt?.status === 'pending'
      && attempt.submitted_at
      && Date.now() - new Date(attempt.submitted_at).getTime() >= AMBIGUOUS_ATTEMPT_REPLAY_CUTOFF_MS
    ) {
      await client.query(
        `UPDATE auto_topup_attempts
         SET status = 'reconciliation_required', updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [attempt.id],
      );
      await disableAutoTopUp(client, teamId, 'ambiguous_attempt_expired');
      return;
    }

    if (!attempt) {
      const usage = await getGrossUsage(client, teamId);
      const denialReason = evaluateAutoTopUpLimits(usage, plannedMicrocents);
      if (denialReason) {
        await disableAutoTopUp(client, teamId, denialReason);
        return;
      }

      // 3. Get Stripe customer ID from team.
      const { rows: teamRows } = await client.query(
        `SELECT stripe_customer_id FROM teams WHERE id = $1`,
        [teamId],
      );

      if (teamRows.length === 0 || !teamRows[0].stripe_customer_id) {
        console.error(`[auto-topup] No Stripe customer for team ${teamId}`);
        return;
      }

      const attemptId = `atu_${randomUUID().replace(/-/g, '')}`;
      const idempotencyKey = `autotopup:${teamId}:${attemptId}`;
      const { rows } = await client.query<AttemptRow>(
        `INSERT INTO auto_topup_attempts
           (id, team_id, idempotency_key, amount_cents, amount_microcents,
            stripe_customer_id, stripe_payment_method_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, idempotency_key, amount_cents, stripe_customer_id,
                   stripe_payment_method_id, payment_intent_id, submitted_at, status`,
        [
          attemptId,
          teamId,
          idempotencyKey,
          reloadAmountCents,
          plannedMicrocents,
          teamRows[0].stripe_customer_id,
          settings.stripe_payment_method_id,
        ],
      );
      attempt = rows[0];
      if (!attempt) throw new Error('failed to reserve auto-topup attempt');
    }

    let paymentIntentId = attempt.payment_intent_id;
    if (attempt.status === 'pending') {
      if (!attempt.stripe_customer_id || !attempt.stripe_payment_method_id) {
        throw new Error('auto-topup attempt is missing its immutable Stripe parameters');
      }

      await client.query(
        `UPDATE auto_topup_attempts
         SET submitted_at = COALESCE(submitted_at, now()), updated_at = now()
         WHERE id = $1`,
        [attempt.id],
      );

      // 4. Create/replay the confirmed PaymentIntent with the attempt's stable
      // key. A retry after an ambiguous response asks Stripe for the same charge.
      let pi: Stripe.PaymentIntent;
      try {
        pi = await stripe.paymentIntents.create(
          {
            amount: Number(attempt.amount_cents),
            currency: 'usd',
            customer: attempt.stripe_customer_id,
            payment_method: attempt.stripe_payment_method_id,
            confirm: true,
            off_session: true,
            metadata: { type: 'auto_topup', team_id: teamId },
          },
          { idempotencyKey: attempt.idempotency_key },
        );
      } catch (err) {
        // Preserve an ambiguous/transient attempt for a same-key replay. A hard
        // decline/configuration failure is known not to have succeeded, so close
        // the attempt and let a later, explicitly re-armed preflight use current
        // payment settings with a fresh key.
        if (!isRetryableTopUpError(err)) {
          await client.query(
            `UPDATE auto_topup_attempts
             SET status = 'failed', stripe_status = $2, failed_at = now(), updated_at = now()
             WHERE id = $1`,
            [attempt.id, err instanceof Stripe.errors.StripeError ? err.type : 'non_retryable_error'],
          );
        }
        throw err;
      }

      if (pi.status !== 'succeeded') {
        await client.query(
          `UPDATE auto_topup_attempts
           SET status = 'failed', stripe_status = $2, failed_at = now(), updated_at = now()
           WHERE id = $1`,
          [attempt.id, pi.status],
        );
        console.error(`[auto-topup] PaymentIntent status '${pi.status}' for team ${teamId}`);
        return;
      }

      paymentIntentId = pi.id;
      await client.query(
        `UPDATE auto_topup_attempts
         SET status = 'charged', payment_intent_id = $2, stripe_status = $3,
             charged_at = now(), updated_at = now()
         WHERE id = $1`,
        [attempt.id, pi.id, pi.status],
      );
    }

    if (!paymentIntentId) throw new Error('charged auto-topup attempt is missing its PaymentIntent');

    // 5. Settlement is replay-safe: addCredits is idempotent on PaymentIntent.
    await addCredits(teamId, Number(attempt.amount_cents), 'auto_topup', paymentIntentId, paymentIntentId);
    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE auto_topup_settings
         SET last_topup_at = now(), disabled_reason = NULL, disabled_at = NULL, updated_at = now()
         WHERE team_id = $1`,
        [teamId],
      );
      await client.query(
        `UPDATE auto_topup_attempts
         SET status = 'settled', settled_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'charged'`,
        [attempt.id],
      );
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        captureException(new Error('auto_topup_settlement_rollback_failed'), {
          tags: {
            source: 'auto_topup_worker',
            stage: 'settlement_rollback',
            errorType: rollbackError instanceof Error ? rollbackError.name : 'unknown',
          },
          extra: { teamId, attemptId: attempt.id },
        });
        console.error(`[auto-topup] Settlement rollback failed for team ${teamId}`);
      }
      throw err;
    }
    console.log(
      `[auto-topup] Charged team ${teamId}: ${attempt.amount_cents} cents`,
    );
  } finally {
    if (lockAcquired) {
      await client.query(`SELECT pg_advisory_unlock(hashtext('auto_topup:' || $1))`, [teamId])
        .catch((err) => console.error(`[auto-topup] Advisory unlock failed for team ${teamId}:`, err));
    }
    client.release();
  }
}
