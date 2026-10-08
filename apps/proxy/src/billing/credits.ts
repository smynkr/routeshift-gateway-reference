import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { calculateCostMicrocents, getModelPricing } from '@routeshift/shared';
import type { ModelPricing } from '@routeshift/shared';
import { getDbPricing } from '../cost/pricing-db.js';

export interface PreFlightResult {
  allowed: boolean;
  balance: number;
  estimatedCost: number;
  reason?: 'missing_pricing';
}

export interface DeductionResult {
  success: boolean;
  newBalance: number;
  amountDeducted: number;
}

export interface UnknownCostHoldSettlementResult extends DeductionResult {
  /** The marked-up unknown-provider amount still withheld for reconciliation. */
  pendingHoldMicrocents: number;
  /** Credits returned from the original reservation in this settlement. */
  amountRefunded: number;
}

type TransactionClient = Pick<PoolClient, 'query' | 'release'>;
const MICROCENTS_PER_CENT = 1_000_000;
const HEARTBEAT_DB_STATEMENT_TIMEOUT_MS = 20_000;
const HEARTBEAT_DB_OPERATION_TIMEOUT_MS = 23_000;

function isStaleReservationRow(row: {
  status: string;
  reason_code?: string | null;
  unknown_attempts?: string | number | null;
  resolved_at?: string | null;
}): boolean {
  return row.status === 'reconciliation_required'
    && row.reason_code === 'stale_credit_reservation'
    && Number(row.unknown_attempts) === 0
    && row.resolved_at == null;
}

/** Apply a whole-percent or fractional-percent plan markup once, rounding up
 * to a whole microcent. Subtracting a tiny tolerance prevents a binary
 * floating representation of an exact integer (for example 12_500 * 1.1)
 * from becoming an accidental one-microcent overcharge. */
export function applyMarkupMicrocents(costMicrocents: number, markupPercent: number): number {
  const cost = Number.isFinite(costMicrocents) ? Math.max(0, costMicrocents) : 0;
  const markup = Number.isFinite(markupPercent) ? Math.max(0, markupPercent) : 0;
  return Math.max(0, Math.ceil((cost * (100 + markup)) / 100 - 1e-9));
}

async function withTransaction<T>(fn: (client: TransactionClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function withHeartbeatTransaction<T>(
  fn: (client: TransactionClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let released = false;
  let deadlineExpired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const releaseOnce = (err?: Error) => {
    if (released) return;
    released = true;
    client.release(err);
  };

  const operation = (async () => {
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${HEARTBEAT_DB_STATEMENT_TIMEOUT_MS}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (!deadlineExpired) {
        try { await client.query('ROLLBACK'); } catch {}
      }
      throw err;
    } finally {
      releaseOnce();
    }
  })();

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          deadlineExpired = true;
          const error = new Error('Credit reservation heartbeat database operation timed out');
          // Passing an error removes and closes this client instead of returning
          // a potentially still-busy connection to the pool.
          try { releaseOnce(error); } catch {}
          reject(error);
        }, HEARTBEAT_DB_OPERATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

export async function getCreditPricing(provider: string, model: string): Promise<ModelPricing | null> {
  return (await getDbPricing(provider, model)) ?? getModelPricing(provider, model);
}

export async function preFlightCreditCheck(
  teamId: string,
  model: string,
  provider: string,
  messageChars: number,
  maxOutputTokens: number | undefined,
  markupPercent: number,
  pluginCostMicrocents: number = 0,
  alreadyReservedMicrocents: number = 0,
): Promise<PreFlightResult> {
  const pricing = await getCreditPricing(provider, model);
  if (!pricing) {
    return { allowed: false, balance: 0, estimatedCost: 0, reason: 'missing_pricing' };
  }

  const estInput = Math.ceil(messageChars / 4);
  const estOutput = maxOutputTokens ?? 4096;
  const estimatedProviderCost = calculateCostMicrocents(
    {
      input_tokens: estInput,
      output_tokens: estOutput,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
    pricing,
  ).total;
  // Plugin fees are a distinct measured cost component. Add them before the
  // plan markup, but never fold them into provider pricing/cost calculation.
  const safePluginCost = Number.isSafeInteger(pluginCostMicrocents)
    ? Math.max(0, pluginCostMicrocents)
    : 0;
  const estimatedCost = applyMarkupMicrocents(estimatedProviderCost + safePluginCost, markupPercent);

  const pool = getPool();

  // credit_balances row is created at registration — just read it
  const { rows } = await pool.query(
    'SELECT balance_microcents FROM credit_balances WHERE team_id = $1',
    [teamId],
  );

  const balance = Number(rows[0]?.balance_microcents ?? 0);

  // A second post-plugin admission can refine a reservation made before a
  // paid plugin ran. Count that held amount as available for this comparison,
  // then reserve only the incremental difference at the caller.
  const safeAlreadyReserved = Number.isSafeInteger(alreadyReservedMicrocents)
    ? Math.max(0, alreadyReservedMicrocents)
    : 0;

  return {
    allowed: balance + safeAlreadyReserved >= estimatedCost,
    balance,
    estimatedCost,
  };
}

export async function deductCredits(
  teamId: string,
  actualCostMicrocents: number,
  markupPercent: number,
  requestId: string,
  description: string,
): Promise<DeductionResult> {
  if (actualCostMicrocents <= 0) {
    const pool = getPool();
    const { rows: balRows } = await pool.query(
      'SELECT balance_microcents FROM credit_balances WHERE team_id = $1',
      [teamId],
    );
    return { success: true, newBalance: Number(balRows[0]?.balance_microcents ?? 0), amountDeducted: 0 };
  }
  const amount = applyMarkupMicrocents(actualCostMicrocents, markupPercent);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE credit_balances
       SET balance_microcents = balance_microcents - $1, updated_at = now()
       WHERE team_id = $2
         AND balance_microcents - $1 >= overdraft_limit_microcents
       RETURNING balance_microcents`,
      [amount, teamId],
    );

    if (rows.length === 0) {
      const { rows: balRows } = await client.query(
        'SELECT balance_microcents FROM credit_balances WHERE team_id = $1',
        [teamId],
      );
      return { success: false, newBalance: Number(balRows[0]?.balance_microcents ?? 0), amountDeducted: 0 };
    }

    const newBalance = Number(rows[0].balance_microcents);
    const txId = `ctx_${randomUUID().replace(/-/g, '')}`;

    await client.query(
      `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
       VALUES ($1, $2, $3, 'deduction', $4, $5, $6)`,
      [txId, teamId, -amount, requestId, description, newBalance],
    );

    return { success: true, newBalance, amountDeducted: amount };
  });
}

export async function reserveCredits(
  teamId: string,
  estimatedCostMicrocents: number,
  requestId: string,
  description: string,
  /** Captured now so a later explicit reconciliation never uses a changed plan. */
  markupPercent: number = 0,
): Promise<DeductionResult> {
  if (
    !Number.isFinite(estimatedCostMicrocents)
    || !Number.isSafeInteger(Math.ceil(estimatedCostMicrocents))
    || estimatedCostMicrocents < 0
  ) {
    throw new Error('estimatedCostMicrocents must be a non-negative safe integer');
  }
  if (!Number.isFinite(markupPercent) || markupPercent < 0) {
    throw new Error('markupPercent must be finite and non-negative');
  }
  const amount = Math.ceil(estimatedCostMicrocents);

  return withTransaction(async (client) => {
    let newBalance: number;
    if (amount === 0) {
      const { rows } = await client.query(
        'SELECT balance_microcents FROM credit_balances WHERE team_id = $1 FOR UPDATE',
        [teamId],
      );
      if (rows.length === 0) return { success: false, newBalance: 0, amountDeducted: 0 };
      newBalance = Number(rows[0].balance_microcents);
    } else {
      const { rows } = await client.query(
        `UPDATE credit_balances
         SET balance_microcents = balance_microcents - $1, updated_at = now()
         WHERE team_id = $2
           AND balance_microcents - $1 >= overdraft_limit_microcents
         RETURNING balance_microcents`,
        [amount, teamId],
      );
      if (rows.length === 0) {
        const { rows: balRows } = await client.query(
          'SELECT balance_microcents FROM credit_balances WHERE team_id = $1', [teamId],
        );
        return { success: false, newBalance: Number(balRows[0]?.balance_microcents ?? 0), amountDeducted: 0 };
      }
      newBalance = Number(rows[0].balance_microcents);
      const txId = `ctx_${randomUUID().replace(/-/g, '')}`;
      await client.query(
        `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
         VALUES ($1, $2, $3, 'deduction', $4, $5, $6)`,
        [txId, teamId, -amount, requestId, `${description} (reservation)`, newBalance],
      );
    }

    const reservationWrite = await client.query(
      `INSERT INTO pending_unknown_cost_holds (
         team_id, request_id, reserved_microcents, known_charge_microcents,
         held_microcents, markup_percent, reason_code, unknown_attempts, status, updated_at
       ) VALUES ($1, $2, $3, 0, $3, $4, 'credit_reservation', 0, 'reserved', now())
       ON CONFLICT (team_id, request_id) DO UPDATE SET
         reserved_microcents = pending_unknown_cost_holds.reserved_microcents + EXCLUDED.reserved_microcents,
         held_microcents = pending_unknown_cost_holds.held_microcents + EXCLUDED.held_microcents,
         updated_at = now()
       WHERE (pending_unknown_cost_holds.status = 'reserved'
           OR (pending_unknown_cost_holds.status = 'reconciliation_required'
             AND pending_unknown_cost_holds.reason_code = 'stale_credit_reservation'
             AND pending_unknown_cost_holds.unknown_attempts = 0
             AND pending_unknown_cost_holds.resolved_at IS NULL))
         AND pending_unknown_cost_holds.markup_percent = EXCLUDED.markup_percent
       RETURNING request_id`,
      [teamId, requestId, amount, markupPercent],
    );
    if (reservationWrite.rows.length === 0) {
      throw new Error('Cannot extend a credit reservation after it entered reconciliation');
    }
    return { success: true, newBalance, amountDeducted: amount };
  });
}

/**
 * Proves that an in-flight streaming request still owns its credit
 * reservation. This intentionally touches no balance or ledger state: it is
 * only a watchdog lease renewal, and it may revive only the exact marker that
 * the watchdog itself wrote before the stream finished.
 */
export async function heartbeatCreditReservation(teamId: string, requestId: string): Promise<void> {
  await withHeartbeatTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE pending_unknown_cost_holds
       SET updated_at = now()
       WHERE team_id = $1 AND request_id = $2
         AND (
           status = 'reserved'
           OR (
             status = 'reconciliation_required'
             AND reason_code = 'stale_credit_reservation'
             AND unknown_attempts = 0
             AND resolved_at IS NULL
           )
         )
       RETURNING request_id`,
      [teamId, requestId],
    );
    if (rows.length !== 1) {
      throw new Error('No active credit reservation exists for heartbeat');
    }
  });
}

export async function settleReservedCredits(
  teamId: string,
  reservedMicrocents: number,
  actualCostMicrocents: number,
  markupPercent: number,
  requestId: string,
  description: string,
): Promise<DeductionResult> {
  const finalAmount = applyMarkupMicrocents(actualCostMicrocents, markupPercent);
  return withTransaction(async (client) => {
    const { rows: reservationRows } = await client.query<{
      reserved_microcents: string;
      markup_percent: string;
      status: string;
      reason_code: string;
      unknown_attempts: number;
      resolved_at: string | null;
    }>(
      `SELECT reserved_microcents, markup_percent, status, reason_code, unknown_attempts, resolved_at
       FROM pending_unknown_cost_holds
       WHERE team_id = $1 AND request_id = $2 FOR UPDATE`,
      [teamId, requestId],
    );
    const reservation = reservationRows[0];
    const requestedReserved = Math.max(0, Math.ceil(reservedMicrocents));
    if (!reservation || (reservation.status !== 'reserved' && !isStaleReservationRow(reservation))) {
      throw new Error('No active credit reservation exists for exact settlement');
    }
    if (Number(reservation.reserved_microcents) !== requestedReserved) {
      throw new Error('Exact settlement reservation does not match the active request reservation');
    }
    if (Number(reservation.markup_percent) !== Math.max(0, markupPercent)) {
      throw new Error('Exact settlement markup does not match the captured reservation markup');
    }
    const delta = finalAmount - requestedReserved;
    const balanceDelta = -delta;
    let newBalance: number;
    if (balanceDelta === 0) {
      const { rows } = await client.query(
        'SELECT balance_microcents FROM credit_balances WHERE team_id = $1 FOR UPDATE', [teamId],
      );
      if (rows.length === 0) return { success: false, newBalance: 0, amountDeducted: requestedReserved };
      newBalance = Number(rows[0].balance_microcents);
    } else {
      const { rows } = await client.query(
        `UPDATE credit_balances
         SET balance_microcents = balance_microcents + $1, updated_at = now()
         WHERE team_id = $2
           AND balance_microcents + $1 >= overdraft_limit_microcents
         RETURNING balance_microcents`,
        [balanceDelta, teamId],
      );

      if (rows.length === 0) {
        // Overage that would breach the overdraft floor. The guarded UPDATE above
        // only fires for refunds and overages the balance can absorb, so reaching
        // here means delta>0 (a charge) that overshoots the floor. Rather than
        // charging nothing — silently letting RouteShift eat the difference —
        // clamp the balance to the floor: collect as much of the overage as the
        // floor permits and retain the unpaid known charge for reconciliation.
        const { rows: curRows } = await client.query(
          'SELECT balance_microcents, overdraft_limit_microcents FROM credit_balances WHERE team_id = $1 FOR UPDATE',
          [teamId],
        );
        if (curRows.length === 0) {
          return { success: false, newBalance: 0, amountDeducted: requestedReserved };
        }
        const current = Number(curRows[0].balance_microcents);
        const floor = Number(curRows[0].overdraft_limit_microcents);
        const target = Math.max(floor, current + balanceDelta);
        const applied = target - current; // <=0: the portion of the overage we can collect
        if (applied >= 0) {
          // Defensive: balance already at/below the floor (should not happen given
          // the reservation guard + overdraft CHECK constraint). Don't refund or
          // no-op-charge; preserve the prior fail-safe behavior.
          return { success: false, newBalance: current, amountDeducted: requestedReserved };
        }
        const uncollected = balanceDelta - applied; // <0: the overage we could not collect
        const uncollectedKnownCharge = Math.abs(uncollected);

        await client.query(
          'UPDATE credit_balances SET balance_microcents = $1, updated_at = now() WHERE team_id = $2',
          [target, teamId],
        );

        const clampTxId = `ctx_${randomUUID().replace(/-/g, '')}`;
        await client.query(
          `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
           VALUES ($1, $2, $3, 'deduction', $4, $5, $6)`,
          [clampTxId, teamId, applied, requestId, `${description} (streaming overage, uncollected ${uncollectedKnownCharge} microcents)`, target],
        );

        // The completed request has a known final charge, but its unpaid portion
        // must remain durable. resolveUnknownCostHold collects this shortfall
        // before it may terminalise the request.
        await client.query(
          `UPDATE pending_unknown_cost_holds SET
             known_charge_microcents = $3,
             uncollected_known_charge_microcents = $4,
             held_microcents = 0,
             unknown_cost_estimate_microcents = NULL,
             reason_code = 'known_charge_overdraft_shortfall',
             unknown_attempts = 0,
             status = 'reconciliation_required',
             updated_at = now()
           WHERE team_id = $1 AND request_id = $2
             AND status IN ('reserved', 'reconciliation_required')`,
          [teamId, requestId, finalAmount, uncollectedKnownCharge],
        );
        return { success: true, newBalance: target, amountDeducted: finalAmount - uncollectedKnownCharge };
      }
      newBalance = Number(rows[0].balance_microcents);
      const txId = `ctx_${randomUUID().replace(/-/g, '')}`;
      const adjustmentDescription = delta > 0
        ? `${description} (streaming overage)`
        : `${description} (streaming reservation refund)`;
      await client.query(
        `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
         VALUES ($1, $2, $3, 'deduction', $4, $5, $6)`,
        [txId, teamId, balanceDelta, requestId, adjustmentDescription, newBalance],
      );
    }
    // Normal exact requests have no reconciliation state to retain.
    await client.query(
      "DELETE FROM pending_unknown_cost_holds WHERE team_id = $1 AND request_id = $2 AND status IN ('reserved', 'reconciliation_required')",
      [teamId, requestId],
    );
    return { success: true, newBalance, amountDeducted: finalAmount };
  });
}

/**
 * Settle the known portion of a request while leaving a durable, bounded hold
 * for provider spend whose actual cost is not yet knowable. Both the balance
 * adjustment and the pending hold are written in one transaction, so a crash
 * cannot refund an ambiguous request without leaving reconciliation evidence.
 *
 * `unknownCostEstimateMicrocents` is a pre-markup provider estimate. Passing
 * null, undefined, NaN, or a negative value means no estimate is available;
 * the remaining reservation is then retained conservatively.
 */
export async function settleReservedCreditsWithUnknownCostHold(
  teamId: string,
  reservedMicrocents: number,
  knownActualCostMicrocents: number,
  unknownCostEstimateMicrocents: number | null | undefined,
  markupPercent: number,
  requestId: string,
  description: string,
  reasonCode: string,
  unknownAttemptCount: number,
): Promise<UnknownCostHoldSettlementResult> {
  const reservedAmount = Math.max(0, Math.ceil(reservedMicrocents));
  const knownAmount = applyMarkupMicrocents(knownActualCostMicrocents, markupPercent);
  const remainingReservation = Math.max(0, reservedAmount - knownAmount);
  const estimateAvailable = typeof unknownCostEstimateMicrocents === 'number'
    && Number.isFinite(unknownCostEstimateMicrocents)
    && unknownCostEstimateMicrocents >= 0;
  const estimatedPendingHoldMicrocents = estimateAvailable
    ? Math.min(
      remainingReservation,
      applyMarkupMicrocents(unknownCostEstimateMicrocents ?? 0, markupPercent),
    )
    : remainingReservation;
  const targetRetained = knownAmount + estimatedPendingHoldMicrocents;
  const safeReasonCode = reasonCode.trim() || 'unknown_provider_cost';
  const safeUnknownAttemptCount = Number.isSafeInteger(unknownAttemptCount)
    ? Math.max(1, unknownAttemptCount)
    : 1;

  return withTransaction(async (client) => {
    // SELECT ... FOR UPDATE cannot lock a row that does not exist. Serialize
    // first creation as well as replay/refinement so concurrent retries cannot
    // both refund from the same original reservation.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [teamId, requestId],
    );

    // A retry may refine the estimate. The durable reservation must already
    // exist because it was inserted atomically with the pre-dispatch debit.
    // Pending replays adjust only their retained difference.
    const { rows: existingRows } = await client.query<{
      reserved_microcents: string;
      known_charge_microcents: string;
      uncollected_known_charge_microcents: string;
      held_microcents: string;
      markup_percent: string;
      status: string;
      reason_code: string;
      unknown_attempts: number;
      resolved_at: string | null;
    }>(
      `SELECT reserved_microcents, known_charge_microcents, uncollected_known_charge_microcents,
              held_microcents, markup_percent, status, reason_code, unknown_attempts, resolved_at
       FROM pending_unknown_cost_holds
       WHERE team_id = $1 AND request_id = $2
       FOR UPDATE`,
      [teamId, requestId],
    );
    const existing = existingRows[0];
    if (!existing || (existing.status !== 'reserved' && existing.status !== 'pending' && !isStaleReservationRow(existing))) {
      throw new Error('No active credit reservation exists for unknown-cost settlement');
    }
    if (Number(existing.reserved_microcents) !== reservedAmount) {
      throw new Error('Unknown-cost settlement reservation does not match the active request reservation');
    }
    if (Number(existing.markup_percent) !== Math.max(0, markupPercent)) {
      throw new Error('Unknown-cost settlement markup does not match the captured reservation markup');
    }

    const priorUncollectedKnownCharge = Math.max(0, Number(existing.uncollected_known_charge_microcents ?? 0) || 0);
    const priorRetained = Number(existing.known_charge_microcents)
      + Number(existing.held_microcents)
      - priorUncollectedKnownCharge;
    const balanceDelta = priorRetained - targetRetained;
    let appliedBalanceDelta = balanceDelta;
    let newBalance: number;

    if (balanceDelta === 0) {
      const { rows } = await client.query(
        'SELECT balance_microcents FROM credit_balances WHERE team_id = $1 FOR UPDATE',
        [teamId],
      );
      if (rows.length === 0) {
        return {
          success: false,
          newBalance: 0,
          amountDeducted: priorRetained,
          pendingHoldMicrocents: Number(existing.held_microcents),
          amountRefunded: 0,
        };
      }
      newBalance = Number(rows[0].balance_microcents);
    } else {
      const { rows } = await client.query(
        `UPDATE credit_balances
         SET balance_microcents = balance_microcents + $1, updated_at = now()
         WHERE team_id = $2
           AND balance_microcents + $1 >= overdraft_limit_microcents
         RETURNING balance_microcents`,
        [balanceDelta, teamId],
      );

      if (rows.length === 0) {
        // A known-cost overage can still exceed the reservation. Preserve the
        // normal settlement floor behavior rather than silently absorbing it.
        if (balanceDelta >= 0) {
          return {
            success: false,
            newBalance: 0,
            amountDeducted: priorRetained,
            pendingHoldMicrocents: Number(existing.held_microcents),
            amountRefunded: 0,
          };
        }
        const { rows: currentRows } = await client.query(
          'SELECT balance_microcents, overdraft_limit_microcents FROM credit_balances WHERE team_id = $1 FOR UPDATE',
          [teamId],
        );
        if (currentRows.length === 0) {
          return {
            success: false,
            newBalance: 0,
            amountDeducted: priorRetained,
            pendingHoldMicrocents: Number(existing.held_microcents),
            amountRefunded: 0,
          };
        }
        const current = Number(currentRows[0].balance_microcents);
        const floor = Number(currentRows[0].overdraft_limit_microcents);
        const target = Math.max(floor, current + balanceDelta);
        const applied = target - current;
        if (applied >= 0) {
          return {
            success: false,
            newBalance: current,
            amountDeducted: priorRetained,
            pendingHoldMicrocents: Number(existing.held_microcents),
            amountRefunded: 0,
          };
        }
        await client.query(
          'UPDATE credit_balances SET balance_microcents = $1, updated_at = now() WHERE team_id = $2',
          [target, teamId],
        );
        appliedBalanceDelta = applied;
        newBalance = target;
      } else {
        newBalance = Number(rows[0].balance_microcents);
      }

      const transactionId = `ctx_${randomUUID().replace(/-/g, '')}`;
      await client.query(
        `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
         VALUES ($1, $2, $3, 'deduction', $4, $5, $6)`,
        [
          transactionId,
          teamId,
          appliedBalanceDelta,
          requestId,
          balanceDelta > 0
            ? `${description} (unknown-cost reservation refund)`
            : `${description} (known-cost settlement overage)`,
          newBalance,
        ],
      );
    }

    const actualRetained = priorRetained - appliedBalanceDelta;
    // Treat collected credit as satisfying exact known spend first; only the
    // remaining known portion becomes an explicit reconciliation liability.
    // The durable unknown hold is likewise derived from the amount actually
    // retained, not the pre-clamp estimate. Otherwise a floor-clamped replay
    // can record more held unknown cost than exists in the balance and let the
    // resolver refund money that was never retained.
    const uncollectedKnownCharge = Math.max(0, knownAmount - actualRetained);
    const actualPendingHoldMicrocents = Math.max(0, actualRetained - knownAmount);
    await client.query(
      `UPDATE pending_unknown_cost_holds SET
         known_charge_microcents = $3,
         uncollected_known_charge_microcents = $4,
         held_microcents = $5,
         unknown_cost_estimate_microcents = $6,
         reason_code = $7,
         unknown_attempts = $8,
         status = 'pending',
         updated_at = now(),
         resolved_at = NULL
       WHERE team_id = $1 AND request_id = $2
         AND (status IN ('reserved', 'pending')
           OR (status = 'reconciliation_required' AND reason_code = 'stale_credit_reservation'
               AND unknown_attempts = 0 AND resolved_at IS NULL))`,
      [
        teamId,
        requestId,
        knownAmount,
        uncollectedKnownCharge,
        actualPendingHoldMicrocents,
        estimateAvailable ? Math.max(0, Math.ceil(unknownCostEstimateMicrocents ?? 0)) : null,
        safeReasonCode,
        safeUnknownAttemptCount,
      ],
    );

    return {
      success: true,
      newBalance,
      amountDeducted: priorRetained - appliedBalanceDelta,
      pendingHoldMicrocents: actualPendingHoldMicrocents,
      amountRefunded: Math.max(0, appliedBalanceDelta),
    };
  });
}

export interface ResolveUnknownCostHoldInput {
  teamId: string;
  requestId: string;
  /** Confirmed pre-markup provider cost for the previously unknown portion. */
  confirmedUnknownCostMicrocents: number;
  /** An operator-verifiable incident, invoice, or provider-usage reference. */
  evidence: string;
  note: string;
  resolvedBy: string;
}

export interface ResolveUnknownCostHoldResult extends DeductionResult {
  status: 'pending' | 'reconciliation_required' | 'reconciled' | 'released';
  alreadyResolved: boolean;
  finalUnknownChargeMicrocents: number;
}

function validateResolutionInput(input: ResolveUnknownCostHoldInput): void {
  if (!Number.isSafeInteger(input.confirmedUnknownCostMicrocents) || input.confirmedUnknownCostMicrocents < 0) {
    throw new Error('confirmedUnknownCostMicrocents must be a non-negative safe integer');
  }
  if (!input.teamId || !input.requestId) throw new Error('teamId and requestId are required');
  if (!input.evidence.trim() || !input.note.trim() || !input.resolvedBy.trim()) {
    throw new Error('Unknown-cost resolution requires evidence, note, and resolvedBy');
  }
}

/**
 * Explicitly reconcile one tenant-scoped pending hold. This is deliberately
 * operator-driven: age never causes an automatic refund. A terminal retry
 * with the identical evidence is a no-op; any different retry is rejected.
 */
export async function resolveUnknownCostHold(
  input: ResolveUnknownCostHoldInput,
): Promise<ResolveUnknownCostHoldResult> {
  validateResolutionInput(input);
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      held_microcents: string;
      known_charge_microcents: string;
      uncollected_known_charge_microcents: string;
      markup_percent: string;
      status: 'pending' | 'reconciliation_required' | 'reconciled' | 'released' | 'reserved';
      resolution_raw_cost_microcents: string | null;
      resolution_charge_microcents: string | null;
      resolution_evidence: string | null;
      resolution_note: string | null;
      resolved_by: string | null;
      reason_code: string | null;
      unknown_attempts: number;
      resolved_at: string | null;
      resolution_eligible: boolean;
    }>(
      `SELECT held_microcents, known_charge_microcents, uncollected_known_charge_microcents,
              markup_percent, status, resolution_raw_cost_microcents,
              resolution_charge_microcents, resolution_evidence, resolution_note, resolved_by,
              reason_code, unknown_attempts, resolved_at,
              CASE
                WHEN status = 'reconciliation_required'
                  AND reason_code = 'stale_credit_reservation'
                  AND unknown_attempts = 0
                  AND resolved_at IS NULL
                THEN updated_at <= now() - interval '10 minutes'
                ELSE true
              END AS resolution_eligible
       FROM pending_unknown_cost_holds
       WHERE team_id = $1 AND request_id = $2 FOR UPDATE`,
      [input.teamId, input.requestId],
    );
    const hold = rows[0];
    if (!hold) throw new Error('Unknown-cost hold was not found for this team and request');
    const finalUnknownChargeMicrocents = applyMarkupMicrocents(
      input.confirmedUnknownCostMicrocents,
      Number(hold.markup_percent),
    );
    const terminalStatus = input.confirmedUnknownCostMicrocents === 0 ? 'released' : 'reconciled';
    if (hold.status === 'reconciled' || hold.status === 'released') {
      const identical = hold.status === terminalStatus
        && Number(hold.resolution_raw_cost_microcents) === input.confirmedUnknownCostMicrocents
        && Number(hold.resolution_charge_microcents) === finalUnknownChargeMicrocents
        && hold.resolution_evidence === input.evidence.trim()
        && hold.resolution_note === input.note.trim()
        && hold.resolved_by === input.resolvedBy.trim();
      if (!identical) throw new Error('Unknown-cost hold was already resolved with conflicting evidence');
      const { rows: balanceRows } = await client.query(
        'SELECT balance_microcents FROM credit_balances WHERE team_id = $1', [input.teamId],
      );
      return {
        success: true,
        newBalance: Number(balanceRows[0]?.balance_microcents ?? 0),
        amountDeducted: Number(hold.known_charge_microcents) + finalUnknownChargeMicrocents,
        status: terminalStatus,
        alreadyResolved: true,
        finalUnknownChargeMicrocents,
      };
    }
    if (hold.status !== 'pending' && hold.status !== 'reconciliation_required') {
      throw new Error('Only pending unknown-cost holds can be resolved');
    }
    if (
      hold.status === 'reconciliation_required'
      && hold.reason_code === 'stale_credit_reservation'
      && Number(hold.unknown_attempts) === 0
      && hold.resolved_at == null
      && hold.resolution_eligible !== true
    ) {
      throw new Error('Stale credit reservation is not eligible for resolution until its 10-minute grace period expires');
    }

    const outstandingKnownCharge = Math.max(0, Number(hold.uncollected_known_charge_microcents ?? 0) || 0);
    const retainedAmount = Math.max(
      0,
      Number(hold.known_charge_microcents) + Number(hold.held_microcents) - outstandingKnownCharge,
    );
    const balanceDelta = Number(hold.held_microcents) - (finalUnknownChargeMicrocents + outstandingKnownCharge);
    let newBalance: number;
    if (balanceDelta === 0) {
      const { rows: balanceRows } = await client.query(
        'SELECT balance_microcents FROM credit_balances WHERE team_id = $1 FOR UPDATE', [input.teamId],
      );
      if (balanceRows.length === 0) return {
        success: false, newBalance: 0, amountDeducted: retainedAmount,
        status: hold.status, alreadyResolved: false, finalUnknownChargeMicrocents,
      };
      newBalance = Number(balanceRows[0].balance_microcents);
    } else {
      const { rows: balanceRows } = await client.query(
        `UPDATE credit_balances SET balance_microcents = balance_microcents + $1, updated_at = now()
         WHERE team_id = $2 AND balance_microcents + $1 >= overdraft_limit_microcents
         RETURNING balance_microcents`,
        [balanceDelta, input.teamId],
      );
      if (balanceRows.length === 0) {
        // A reconciliation may discover a charge beyond the held estimate. Do
        // not terminalise it if applying the difference would breach the floor.
        const { rows: currentRows } = await client.query(
          'SELECT balance_microcents FROM credit_balances WHERE team_id = $1 FOR UPDATE', [input.teamId],
        );
        return {
          success: false,
          newBalance: Number(currentRows[0]?.balance_microcents ?? 0),
          amountDeducted: retainedAmount,
          status: hold.status,
          alreadyResolved: false,
          finalUnknownChargeMicrocents,
        };
      }
      newBalance = Number(balanceRows[0].balance_microcents);
      await client.query(
        `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
         VALUES ($1, $2, $3, 'deduction', $4, $5, $6)`,
        [
          `ctx_${randomUUID().replace(/-/g, '')}`,
          input.teamId,
          balanceDelta,
          input.requestId,
          input.confirmedUnknownCostMicrocents === 0
            ? `${input.note.trim()} (unknown-cost hold released)`
            : `${input.note.trim()} (unknown-cost hold reconciled)`,
          newBalance,
        ],
      );
    }
    await client.query(
      `UPDATE pending_unknown_cost_holds SET
         status = $3, resolved_at = now(), resolution_raw_cost_microcents = $4,
         resolution_charge_microcents = $5, resolution_evidence = $6,
         resolution_note = $7, resolved_by = $8,
         uncollected_known_charge_microcents = 0, updated_at = now()
       WHERE team_id = $1 AND request_id = $2
         AND status IN ('pending', 'reconciliation_required')`,
      [
        input.teamId, input.requestId, terminalStatus, input.confirmedUnknownCostMicrocents,
        finalUnknownChargeMicrocents, input.evidence.trim(), input.note.trim(), input.resolvedBy.trim(),
      ],
    );
    return {
      success: true, newBalance, amountDeducted: Number(hold.known_charge_microcents) + finalUnknownChargeMicrocents,
      status: terminalStatus, alreadyResolved: false, finalUnknownChargeMicrocents,
    };
  });
}

/** Marks old in-flight reservations for human reconciliation only. Never moves money. */
export async function markStaleCreditReservationsForReconciliation(
  staleAfterMs: number = 30 * 60 * 1000,
): Promise<number> {
  const safeStaleAfterMs = Number.isSafeInteger(staleAfterMs) ? Math.max(60_000, staleAfterMs) : 30 * 60 * 1000;
  const { rows } = await getPool().query<{
    team_id: string;
    request_id: string;
    reserved_microcents: string;
    previous_updated_at: string;
  }>(
    `WITH stale AS (
       SELECT team_id, request_id, reserved_microcents, updated_at AS previous_updated_at
       FROM pending_unknown_cost_holds
       WHERE status = 'reserved'
         AND updated_at < now() - ($1::bigint * interval '1 millisecond')
       FOR UPDATE SKIP LOCKED
     )
     UPDATE pending_unknown_cost_holds hold SET
       status = 'reconciliation_required',
       updated_at = now(),
       reason_code = CASE
         WHEN hold.reason_code = 'credit_reservation' THEN 'stale_credit_reservation'
         ELSE hold.reason_code
       END
     FROM stale
     WHERE hold.team_id = stale.team_id
       AND hold.request_id = stale.request_id
       AND hold.status = 'reserved'
     RETURNING hold.team_id, hold.request_id, hold.reserved_microcents, stale.previous_updated_at`,
    [safeStaleAfterMs],
  );
  for (const row of rows) {
    console.error(JSON.stringify({
      event: 'routeshift_stale_credit_reservation_requires_reconciliation',
      team_id: row.team_id,
      request_id: row.request_id,
      reserved_microcents: Number(row.reserved_microcents),
      stale_after_ms: safeStaleAfterMs,
      last_updated_at: row.previous_updated_at,
    }));
  }
  return rows.length;
}

export async function checkAutoTopUpNeeded(
  teamId: string,
  balance: number,
): Promise<void> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT threshold_microcents
     FROM auto_topup_settings
     WHERE team_id = $1 AND enabled = true AND stripe_payment_method_id IS NOT NULL`,
    [teamId],
  );

  if (rows.length === 0) return;

  const threshold = Number(rows[0].threshold_microcents);

  if (balance < threshold) {
    await pool.query(
      `INSERT INTO auto_topup_queue (team_id)
       VALUES ($1)
       ON CONFLICT DO NOTHING`,
      [teamId],
    );
  }
}

export async function addCredits(
  teamId: string,
  amountCents: number,
  type: 'purchase' | 'auto_topup',
  referenceId: string,
  // When supplied, the credit is applied at most once per key (migration 039).
  // The auto-topup worker keys this by the Stripe PaymentIntent id so a crash/retry
  // that replays the same already-succeeded charge can't double-credit the team.
  idempotencyKey?: string,
): Promise<number> {
  const microcents = amountCents * MICROCENTS_PER_CENT;
  return withTransaction(async (client) => {
    if (type === 'auto_topup') {
      // This parent row is the shared lock with the dashboard Stripe webhook.
      // Whichever writer arrives first serializes the PaymentIntent while it
      // reads pending refunds/disputes and writes the ledger/balance atomically.
      const { rows: insertedRows } = await client.query<{
        team_id: string;
        credit_kind: string;
        amount_microcents: number | string;
        credit_applied: boolean;
      }>(
        `INSERT INTO credit_payment_intents
           (payment_intent_id, team_id, credit_kind, amount_microcents)
         VALUES ($1, $2, 'auto_topup', $3)
         ON CONFLICT (payment_intent_id) DO UPDATE SET updated_at = now()
         RETURNING team_id, credit_kind, amount_microcents, credit_applied`,
        [referenceId, teamId, microcents],
      );
      const { rows: lockedRows } = await client.query<{
        team_id: string;
        credit_kind: string;
        amount_microcents: number | string;
        credit_applied: boolean;
      }>(
        `SELECT team_id, credit_kind, amount_microcents, credit_applied
         FROM credit_payment_intents
         WHERE payment_intent_id = $1
         FOR UPDATE`,
        [referenceId],
      );
      const parent = lockedRows[0] ?? insertedRows[0];
      if (
        !parent
        || parent.team_id !== teamId
        || parent.credit_kind !== 'auto_topup'
        || Number(parent.amount_microcents) !== microcents
      ) {
        throw new Error(`auto-topup PaymentIntent ${referenceId} does not match its persisted credit state`);
      }

      let creditAlreadyApplied = parent.credit_applied;
      if (!creditAlreadyApplied) {
        // Migration 039 intentionally left historical idempotency_key values
        // NULL. Bootstrap a parent state from any pre-048 reference-keyed
        // ledger row so a delayed success event cannot credit it again.
        const { rows: legacyRows } = await client.query(
          `SELECT 1 FROM credit_transactions
           WHERE type = 'auto_topup'
             AND (reference_id = $1 OR idempotency_key = $1)
           LIMIT 1`,
          [referenceId],
        );
        if (legacyRows.length > 0) {
          await client.query(
            `UPDATE credit_payment_intents
             SET credit_applied = true, updated_at = now()
             WHERE payment_intent_id = $1`,
            [referenceId],
          );
          creditAlreadyApplied = true;
        }
      }
      if (creditAlreadyApplied) {
        const { rows } = await client.query(
          `SELECT balance_microcents FROM credit_balances WHERE team_id = $1`,
          [teamId],
        );
        return Number(rows[0]?.balance_microcents ?? 0);
      }
    }

    // Ensure row exists before updating.
    await client.query(
      `INSERT INTO credit_balances (team_id, balance_microcents) VALUES ($1, 0) ON CONFLICT (team_id) DO NOTHING`,
      [teamId],
    );

    // Stripe can deliver a refund or dispute before either the worker or
    // payment_intent.succeeded webhook writes the positive auto-topup ledger
    // row. Persisted reversal state turns that otherwise-lost event into a
    // reduced (or zero) credit, so a reversed PaymentIntent never becomes
    // usable simply because delivery was out of order.
    let creditedMicrocents = microcents;
    if (type === 'auto_topup') {
      const { rows } = await client.query<{ withheld_microcents: number | string }>(
        `SELECT COALESCE(SUM(amount_microcents) FILTER (
                  WHERE kind = 'refund' OR (kind = 'dispute' AND status = 'active')
                ), 0) AS withheld_microcents
         FROM credit_payment_reversals
         WHERE payment_intent_id = $1`,
        [referenceId],
      );
      const withheldMicrocents = Math.max(0, Number(rows[0]?.withheld_microcents ?? 0));
      creditedMicrocents = Math.max(0, microcents - withheldMicrocents);
    }
    const description = creditedMicrocents === microcents
      ? `${type}: $${(amountCents / 100).toFixed(2)}`
      : `${type}: $${(creditedMicrocents / MICROCENTS_PER_CENT / 100).toFixed(2)} after pending reversal`;

    if (idempotencyKey) {
      // Claim the key atomically by writing the ledger row first. A replay of the
      // same key conflicts on the partial unique index and inserts nothing, so we
      // skip the balance bump entirely and leave the balance untouched.
      const txId = `ctx_${randomUUID().replace(/-/g, '')}`;
      const claim = await client.query(
        `INSERT INTO credit_transactions
           (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [txId, teamId, creditedMicrocents, type, referenceId, description, idempotencyKey],
      );
      if (claim.rows.length === 0) {
        // Already applied for this key — return the current balance, do NOT re-credit.
        if (type === 'auto_topup') {
          await client.query(
            `UPDATE credit_payment_intents
             SET credit_applied = true, updated_at = now()
             WHERE payment_intent_id = $1`,
            [referenceId],
          );
        }
        const { rows } = await client.query(
          `SELECT balance_microcents FROM credit_balances WHERE team_id = $1`,
          [teamId],
        );
        return Number(rows[0]?.balance_microcents ?? 0);
      }
      // Bump the balance and record the TRUE post-update running balance on the
      // ledger row. RETURNING reflects any concurrent committed deduction, so
      // balance_after_microcents stays accurate — matching the non-idempotent path.
      const { rows } = await client.query(
        `UPDATE credit_balances
         SET balance_microcents = balance_microcents + $1, updated_at = now()
         WHERE team_id = $2
         RETURNING balance_microcents`,
        [creditedMicrocents, teamId],
      );
      const newBalance = Number(rows[0]?.balance_microcents ?? microcents);
      await client.query(
        `UPDATE credit_transactions SET balance_after_microcents = $1 WHERE id = $2`,
        [newBalance, txId],
      );
      if (type === 'auto_topup') {
        await client.query(
          `UPDATE credit_payment_intents
           SET credit_applied = true, updated_at = now()
           WHERE payment_intent_id = $1`,
          [referenceId],
        );
      }
      return newBalance;
    }

    const { rows } = await client.query(
      `UPDATE credit_balances
       SET balance_microcents = balance_microcents + $1, updated_at = now()
       WHERE team_id = $2
       RETURNING balance_microcents`,
      [creditedMicrocents, teamId],
    );

    const newBalance = Number(rows[0]?.balance_microcents ?? microcents);
    const txId = `ctx_${randomUUID().replace(/-/g, '')}`;

    await client.query(
      `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [txId, teamId, creditedMicrocents, type, referenceId, description, newBalance],
    );

    if (type === 'auto_topup') {
      await client.query(
        `UPDATE credit_payment_intents
         SET credit_applied = true, updated_at = now()
         WHERE payment_intent_id = $1`,
        [referenceId],
      );
    }

    return newBalance;
  });
}
