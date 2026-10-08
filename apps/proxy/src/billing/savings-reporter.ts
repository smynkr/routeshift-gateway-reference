import { getPool } from '../db/pool.js';
import { getPlanLimits } from './plan-limits.js';

/**
 * Convert accumulated savings (microcents) into the Stripe meter value (whole
 * cents) for a given savings-share percentage.
 *
 * Unit reminder: 1 USD = 100_000_000 microcents, so 1 cent = 1_000_000
 * microcents. `sharePercent` is a WHOLE percent (e.g. 3 means 3%), so the
 * share divides by an additional 100. Omitting that /100 overbills by 100x —
 * the customer would be metered the full savings (×percent) instead of a
 * percent of it.
 */
export function computeSavingsShareCents(savingsMicrocents: number, sharePercent: number): number {
  // This function's return value IS the Stripe meter value, so it validates its
  // own inputs rather than trusting any caller's SQL. The reporter's query
  // already clamps per row with GREATEST(savings_microcents, 0), so a negative
  // savings figure cannot reach here today — but this function is exported, a
  // negative share emits a meter event that CREDITS the customer, and RSH-134's
  // quality cascade makes negative per-request savings systematically reachable
  // for the first time (an expensive cascade legitimately costs more than the
  // requested model).
  //
  // Clamp BOTH operands, not just savings. An earlier version floored only
  // `savingsMicrocents`, which left the identical hole one argument over: a
  // negative `sharePercent` still produced a negative meter value that CREDITS
  // the customer. `getPlanLimits` supplies only 0 or 3 today, so that is not
  // reachable through the current caller — but "unreachable through the one
  // caller we have" is exactly the reasoning this guard exists to stop relying on.
  const savingsCents = Math.max(savingsMicrocents, 0) / 1_000_000;
  const shareCents = Math.round((savingsCents * Math.max(sharePercent, 0)) / 100);
  // Both operands are clamped non-negative, so this cannot be negative — but it
  // can still be NaN (a NaN operand, or 0 × Infinity) or Infinity, and
  // `reportSavings` skips only on `=== 0`, so either would reach the meter
  // event's `value:` field as the literal string "NaN" or "Infinity". Checking
  // the value actually returned covers every non-finite path into it, which is
  // why there is no separate input-side finite check: it would be dead code.
  return Number.isFinite(shareCents) ? shareCents : 0;
}

const REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let reportTimer: NodeJS.Timeout | null = null;

export function startSavingsReporter(): void {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_METER_EVENT_NAME) {
    console.log('Savings reporter disabled: STRIPE_SECRET_KEY or STRIPE_METER_EVENT_NAME not set');
    return;
  }
  setTimeout(() => reportSavings(), 5000);
  reportTimer = setInterval(() => reportSavings(), REPORT_INTERVAL_MS);
  console.log('Savings reporter started (24h interval)');
}

export function stopSavingsReporter(): void {
  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
}

export async function reportSavings(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // SESSION-level advisory lock (not xact-scoped): it must outlive the
    // per-team commits below while still guaranteeing a single writer across
    // replicas. Released in finally. Expected to fail on every replica that
    // loses the race — silent return.
    const { rows: [{ pg_try_advisory_lock: acquired }] } = await client.query('SELECT pg_try_advisory_lock(1)');
    if (!acquired) return;

    const { rows: subs } = await client.query(
      `SELECT team_id, stripe_customer_id, plan, last_savings_report
       FROM subscriptions WHERE status = 'active' AND plan != 'free'`,
    );

    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-02-25.clover',
    });
    const meterEventName = process.env.STRIPE_METER_EVENT_NAME!;

    for (const sub of subs) {
      // Isolate each team: a transient DB error for one team must not abort the
      // batch for the rest (the advisory lock is held for the whole run).
      try {
        const limits = getPlanLimits(sub.plan);
        if (limits.savingsSharePercent === 0) continue;

        // The window cursor is derived from savings_reports (the source of
        // truth), NOT the subscriptions watermark. This is what makes a
        // committed claim alone advance the cursor: even if a later step crashes
        // before the watermark UPDATE, the next run sees MAX(window_end) and
        // moves on — no permanent billing stall. Genesis (no prior report) falls
        // back to the subscription's own last_savings_report (its creation/redeem
        // time) so we never bill savings accrued before the subscription existed.
        const { rows: [cursor] } = await client.query(
          `SELECT COALESCE(MAX(window_end), $2) AS window_start
             FROM savings_reports WHERE team_id = $1`,
          [sub.team_id, sub.last_savings_report],
        );
        const windowStart = new Date(cursor.window_start).toISOString();
        const reportEnd = new Date().toISOString();

        const { rows: [result] } = await client.query(
          `SELECT COALESCE(SUM(GREATEST(savings_microcents, 0)), 0)::bigint AS total_savings
           FROM request_logs
          WHERE team_id = $1
            AND billing_mode = 'subscription'
            AND actual_cost_known = true
            AND timestamp > $2
            AND timestamp <= $3`,
          [sub.team_id, windowStart, reportEnd],
        );

        const totalSavingsMicrocents = Number(result.total_savings);
        if (totalSavingsMicrocents === 0) continue;

        const shareInCents = computeSavingsShareCents(totalSavingsMicrocents, limits.savingsSharePercent);
        if (shareInCents === 0) continue;

        // Claim the (team, window) atomically BEFORE billing. The PK on
        // savings_reports makes it impossible to bill the same window twice —
        // even across a crash, and even if Stripe's meter-event dedup window
        // (shorter than our 24h cadence) has lapsed. A conflict means a prior
        // run already billed this window, so skip. At-most-once: we prefer a
        // rare crash-window skip over ever double-charging a customer.
        const claim = await client.query(
          `INSERT INTO savings_reports (team_id, window_start, window_end, share_cents)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (team_id, window_start) DO NOTHING`,
          [sub.team_id, windowStart, reportEnd, shareInCents],
        );
        if (claim.rowCount === 0) continue;

        try {
          await stripe.billing.meterEvents.create({
            event_name: meterEventName,
            identifier: `savings:${sub.team_id}:${windowStart}`,
            payload: { value: String(shareInCents), stripe_customer_id: sub.stripe_customer_id },
          });
        } catch (err) {
          // Billing failed — release the claim so the window is retried next run.
          await client.query('DELETE FROM savings_reports WHERE team_id = $1 AND window_start = $2', [sub.team_id, windowStart]);
          console.error(`Failed to report savings for team ${sub.team_id}:`, err);
          continue;
        }

        // Billing succeeded and the claim is committed. Keep the legacy watermark
        // in step for display on a BEST-EFFORT basis only: a failure here must NOT
        // release the claim. Re-billing the window on a later run would double-charge
        // the customer once Stripe's meter-event dedup window (shorter than our 24h
        // cadence) has lapsed. The MAX(window_end) cursor already advanced via the
        // committed claim, so a missing watermark is harmless (see crash-B regression).
        try {
          await client.query('UPDATE subscriptions SET last_savings_report = $2 WHERE team_id = $1', [sub.team_id, reportEnd]);
        } catch (err) {
          console.error(`Savings watermark update failed for team ${sub.team_id} (non-fatal):`, err);
        }
        console.log(`Reported ${shareInCents}¢ savings share for team ${sub.team_id}`);
      } catch (err) {
        console.error(`Savings reporting error for team ${sub.team_id}:`, err);
      }
    }
  } catch (err) {
    console.error('Savings reporter error:', err);
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(1)'); } catch { /* ignore */ }
    client.release();
  }
}
