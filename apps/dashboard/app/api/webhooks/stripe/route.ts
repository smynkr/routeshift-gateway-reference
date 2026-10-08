import { NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import { getPool } from '@/lib/db';
import type Stripe from 'stripe';

function planFromPriceId(priceId: string): string {
  // LAY-344 Option A: STRIPE_PRO_METERED_PRICE_ID is the canonical
  // active price. Legacy STRIPE_*_PRICE_ID env vars are no longer used
  // for new checkouts but stay in the map so any pre-existing
  // subscriptions resolve correctly to `pro` (functionally identical
  // limits — see PLAN_LIMITS in apps/proxy/src/billing/plan-limits.ts).
  const map: Record<string, string> = {
    [process.env.STRIPE_PRO_METERED_PRICE_ID!]: 'pro',
    [process.env.STRIPE_STARTER_PRICE_ID!]: 'pro',
    [process.env.STRIPE_STARTER_METERED_PRICE_ID!]: 'pro',
    [process.env.STRIPE_GROWTH_PRICE_ID!]: 'pro',
    [process.env.STRIPE_GROWTH_METERED_PRICE_ID!]: 'pro',
    [process.env.STRIPE_ENTERPRISE_PRICE_ID!]: 'pro',
    [process.env.STRIPE_ENTERPRISE_METERED_PRICE_ID!]: 'pro',
  };
  // Strip the empty-string key that appears when an env var is unset —
  // otherwise a webhook with empty priceId would incorrectly resolve.
  delete map[''];
  if (!map[priceId]) console.error(`Unknown Stripe Price ID: ${priceId} — defaulting to free`);
  return map[priceId] ?? 'free';
}

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET not configured — rejecting webhook');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature header' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const pool = getPool();
  const client = await pool.connect();

  type CreditKind = 'purchase' | 'auto_topup';

  type CreditOrigin = {
    teamId: string;
    kind: CreditKind;
    amountMicrocents: number;
  };

  type CreditParent = CreditOrigin & {
    creditApplied: boolean;
  };

  const getCreditPurchase = async (paymentIntentId: string): Promise<CreditOrigin | undefined> => {
    const { rows } = await client.query<{ team_id: string; amount_cents: number | string }>(
      `SELECT team_id, amount_cents
       FROM credit_purchases
       WHERE stripe_payment_intent_id = $1
       LIMIT 1`,
      [paymentIntentId],
    );
    if (!rows[0]) return undefined;
    return {
      teamId: rows[0].team_id,
      kind: 'purchase',
      amountMicrocents: Number(rows[0].amount_cents) * 1_000_000,
    };
  };

  const getAutoTopupLedger = async (paymentIntentId: string): Promise<CreditOrigin | undefined> => {
    const { rows } = await client.query<{
      team_id: string;
      amount_microcents: number | string;
    }>(
      `SELECT team_id, amount_microcents
       FROM credit_transactions
       WHERE type = 'auto_topup'
         AND (reference_id = $1 OR idempotency_key = $1)
       ORDER BY created_at DESC
       LIMIT 1`,
      [paymentIntentId],
    );
    if (!rows[0]) return undefined;
    return {
      teamId: rows[0].team_id,
      kind: 'auto_topup',
      amountMicrocents: Number(rows[0].amount_microcents),
    };
  };

  const getCreditParent = async (paymentIntentId: string): Promise<CreditParent | undefined> => {
    const { rows } = await client.query<{
      team_id: string;
      credit_kind: CreditKind;
      amount_microcents: number | string;
      credit_applied: boolean;
    }>(
      `SELECT team_id, credit_kind, amount_microcents, credit_applied
       FROM credit_payment_intents
       WHERE payment_intent_id = $1
       LIMIT 1`,
      [paymentIntentId],
    );
    if (!rows[0]) return undefined;
    return {
      teamId: rows[0].team_id,
      kind: rows[0].credit_kind,
      amountMicrocents: Number(rows[0].amount_microcents),
      creditApplied: rows[0].credit_applied,
    };
  };

  // A reversal can arrive before its Checkout Session or auto-topup writer has
  // stored local state. Resolve the signed PaymentIntent metadata first; older
  // Checkout PaymentIntents without copied metadata fall back to their session.
  const resolveCreditOrigin = async (paymentIntentId: string): Promise<CreditOrigin | undefined> => {
    const purchase = await getCreditPurchase(paymentIntentId);
    if (purchase) return purchase;

    const parent = await getCreditParent(paymentIntentId);
    if (parent) return parent;

    const autoTopupLedger = await getAutoTopupLedger(paymentIntentId);
    if (autoTopupLedger) return autoTopupLedger;

    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const metadata = paymentIntent.metadata ?? {};
      const amountMicrocents = (paymentIntent.amount_received || paymentIntent.amount) * 1_000_000;
      if (metadata.type === 'auto_topup' || metadata.type === 'credits') {
        if (!metadata.team_id || !amountMicrocents || amountMicrocents <= 0) {
          throw new Error(`credit PaymentIntent ${paymentIntentId} has incomplete signed metadata`);
        }
        return {
          teamId: metadata.team_id,
          kind: metadata.type === 'auto_topup' ? 'auto_topup' : 'purchase',
          amountMicrocents,
        };
      }
      if (metadata.type) return undefined;

      const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
      const session = sessions.data[0];
      if (session?.metadata?.type !== 'credits' || !session.metadata.team_id) return undefined;
      const sessionAmountMicrocents = (session.amount_total ?? paymentIntent.amount) * 1_000_000;
      if (!sessionAmountMicrocents || sessionAmountMicrocents <= 0) {
        throw new Error(`credit Checkout Session for ${paymentIntentId} has no positive amount`);
      }
      return {
        teamId: session.metadata.team_id,
        kind: 'purchase',
        amountMicrocents: sessionAmountMicrocents,
      };
    } catch (err) {
      // A failed provenance lookup must roll back the stripe_events claim so
      // Stripe retries rather than permanently acknowledging a lost reversal.
      console.error('Failed to resolve PaymentIntent for credit reversal', err);
      throw err;
    }
  };

  const lockCreditPaymentIntent = async (
    paymentIntentId: string,
    origin: CreditOrigin,
  ): Promise<CreditParent> => {
    await client.query(
      `INSERT INTO credit_payment_intents
         (payment_intent_id, team_id, credit_kind, amount_microcents)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (payment_intent_id) DO UPDATE SET updated_at = now()`,
      [paymentIntentId, origin.teamId, origin.kind, origin.amountMicrocents],
    );
    const { rows } = await client.query<{
      team_id: string;
      credit_kind: CreditKind;
      amount_microcents: number | string;
      credit_applied: boolean;
    }>(
      `SELECT team_id, credit_kind, amount_microcents, credit_applied
       FROM credit_payment_intents
       WHERE payment_intent_id = $1
       FOR UPDATE`,
      [paymentIntentId],
    );
    const parent = rows[0];
    if (
      !parent
      || parent.team_id !== origin.teamId
      || parent.credit_kind !== origin.kind
      || Number(parent.amount_microcents) !== origin.amountMicrocents
    ) {
      throw new Error(`credit PaymentIntent ${paymentIntentId} does not match its persisted state`);
    }
    return {
      teamId: parent.team_id,
      kind: parent.credit_kind,
      amountMicrocents: Number(parent.amount_microcents),
      creditApplied: parent.credit_applied,
    };
  };

  const bootstrapCreditApplied = async (
    paymentIntentId: string,
    parent: CreditParent,
  ): Promise<CreditParent> => {
    if (parent.creditApplied) return parent;
    const historicalCredit = parent.kind === 'purchase'
      ? await getCreditPurchase(paymentIntentId)
      : await getAutoTopupLedger(paymentIntentId);
    if (!historicalCredit) return parent;
    await client.query(
      `UPDATE credit_payment_intents
       SET credit_applied = true, updated_at = now()
       WHERE payment_intent_id = $1`,
      [paymentIntentId],
    );
    return { ...parent, creditApplied: true };
  };

  const markCreditApplied = async (paymentIntentId: string): Promise<void> => {
    await client.query(
      `UPDATE credit_payment_intents
       SET credit_applied = true, updated_at = now()
       WHERE payment_intent_id = $1`,
      [paymentIntentId],
    );
  };

  const getPendingReversalMicrocents = async (paymentIntentId: string): Promise<number> => {
    const { rows } = await client.query<{ withheld_microcents: number | string }>(
      `SELECT COALESCE(SUM(amount_microcents) FILTER (
                WHERE kind = 'refund' OR (kind = 'dispute' AND status = 'active')
              ), 0) AS withheld_microcents
       FROM credit_payment_reversals
       WHERE payment_intent_id = $1`,
      [paymentIntentId],
    );
    return Math.max(0, Number(rows[0]?.withheld_microcents ?? 0));
  };

  const getAvailableCreditMicrocents = async (
    paymentIntentId: string,
    parent: CreditParent,
  ): Promise<number> => Math.max(0, parent.amountMicrocents - await getPendingReversalMicrocents(paymentIntentId));

  const recordRefund = async (
    paymentIntentId: string,
    refundId: string,
    amountMicrocents: number,
  ): Promise<boolean> => {
    const { rows } = await client.query(
      `INSERT INTO credit_payment_reversals
         (payment_intent_id, reversal_id, kind, amount_microcents, status)
       VALUES ($1, $2, 'refund', $3, 'active')
       ON CONFLICT (payment_intent_id, reversal_id) DO NOTHING
       RETURNING reversal_id`,
      [paymentIntentId, refundId, amountMicrocents],
    );
    return rows.length > 0;
  };

  const recordDisputeWithdrawal = async (
    paymentIntentId: string,
    disputeId: string,
    amountMicrocents: number,
  ): Promise<boolean> => {
    const { rows } = await client.query(
      `INSERT INTO credit_payment_reversals
         (payment_intent_id, reversal_id, kind, amount_microcents, status)
       VALUES ($1, $2, 'dispute', $3, 'active')
       ON CONFLICT (payment_intent_id, reversal_id) DO NOTHING
       RETURNING reversal_id`,
      [paymentIntentId, disputeId, amountMicrocents],
    );
    // A reinstatement can be delivered first. Its final state wins, so a late
    // withdrawal cannot re-claw funds or re-suspend the team.
    return rows.length > 0;
  };

  const markDisputeReinstated = async (
    paymentIntentId: string,
    disputeId: string,
    amountMicrocents: number,
  ): Promise<boolean> => {
    const transition = async () => client.query(
      `UPDATE credit_payment_reversals
       SET status = 'reinstated', updated_at = now()
       WHERE payment_intent_id = $1
         AND reversal_id = $2
         AND kind = 'dispute'
         AND status = 'active'
       RETURNING reversal_id`,
      [paymentIntentId, disputeId],
    );
    if ((await transition()).rows.length > 0) return true;

    const { rows } = await client.query(
      `INSERT INTO credit_payment_reversals
         (payment_intent_id, reversal_id, kind, amount_microcents, status)
       VALUES ($1, $2, 'dispute', $3, 'reinstated')
       ON CONFLICT (payment_intent_id, reversal_id) DO NOTHING
       RETURNING reversal_id`,
      [paymentIntentId, disputeId, amountMicrocents],
    );
    if (rows.length > 0) return false;
    return (await transition()).rows.length > 0;
  };

  const applyReversalDelta = async (
    teamId: string,
    deltaMicrocents: number,
    type: 'refund' | 'dispute',
    referenceId: string,
    description: string,
  ): Promise<void> => {
    if (deltaMicrocents === 0) return;
    const { rows } = await client.query(
      `UPDATE credit_balances
       SET balance_microcents = balance_microcents + $1, updated_at = now()
       WHERE team_id = $2
       RETURNING balance_microcents`,
      [deltaMicrocents, teamId],
    );
    const txId = `ctx_${crypto.randomUUID().replace(/-/g, '')}`;
    await client.query(
      `INSERT INTO credit_transactions
         (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [txId, teamId, deltaMicrocents, type, referenceId, description, Number(rows[0]?.balance_microcents ?? 0)],
    );
  };

  try {
    await client.query('BEGIN');

    // Atomic idempotency check-and-claim
    const { rowCount } = await client.query(
      'INSERT INTO stripe_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING',
      [event.id],
    );
    if (rowCount === 0) {
      // Duplicate event (Stripe re-delivers normally). ROLLBACK and return — do
      // NOT release here: the `finally` releases exactly once. Releasing twice
      // throws on pg-pool (release-of-already-released client), and a throwing
      // `finally` replaces this 200 with a 500 — turning the idempotent
      // duplicate-ACK into a perpetual Stripe retry/alert.
      await client.query('ROLLBACK');
      return NextResponse.json({ received: true, duplicate: true });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        // Handle credit purchases
        if (session.metadata?.type === 'credits') {
          // Only credit the balance once Stripe has actually captured payment.
          // checkout.session.completed can fire with payment_status 'unpaid' /
          // 'no_payment_required' for async/delayed payment methods; crediting
          // then would hand out balance before the money settles.
          if (session.payment_status !== 'paid') {
            console.error(
              `credits checkout.session.completed with payment_status=${session.payment_status} — not crediting`,
              { sessionId: session.id },
            );
            break;
          }
          const teamId = session.metadata.team_id;
          const amountCents = session.amount_total ?? 0;
          if (!teamId || amountCents <= 0) {
            console.error('credits checkout missing team_id or non-positive amount', {
              teamId,
              amountCents,
            });
            break;
          }
          const paymentIntentId = session.payment_intent as string;
          if (!paymentIntentId) {
            console.error('credits checkout missing PaymentIntent', { sessionId: session.id, teamId });
            break;
          }
          let parent = await lockCreditPaymentIntent(paymentIntentId, {
            teamId,
            kind: 'purchase',
            amountMicrocents: amountCents * 1_000_000,
          });
          parent = await bootstrapCreditApplied(paymentIntentId, parent);
          if (parent.creditApplied) {
            console.error('credits checkout: PaymentIntent already has applied credit state, skipping re-credit', {
              eventId: event.id,
              sessionId: session.id,
              paymentIntent: paymentIntentId,
              teamId,
            });
            await client.query('COMMIT');
            return NextResponse.json({ received: true, duplicate: true });
          }
          const creditedMicrocents = await getAvailableCreditMicrocents(paymentIntentId, parent);
          const purchaseId = `cpurch_${crypto.randomUUID().replace(/-/g, '')}`;

          // Insert purchase record
          const { rowCount: purchaseRowCount } = await client.query(
            `INSERT INTO credit_purchases (id, team_id, amount_cents, stripe_payment_intent_id, status) VALUES ($1, $2, $3, $4, 'completed') ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
            [purchaseId, teamId, amountCents, paymentIntentId],
          );
          if ((purchaseRowCount ?? 0) === 0) {
            // A historical row can pre-date the parent state; preserve its
            // applied status so a future retry cannot create a second credit.
            await markCreditApplied(paymentIntentId);
            console.error('credits checkout: duplicate stripe_payment_intent_id, skipping re-credit', {
              eventId: event.id,
              sessionId: session.id,
              paymentIntent: paymentIntentId,
              teamId,
            });
            await client.query('COMMIT');
            return NextResponse.json({ received: true, duplicate: true });
          }

          // Ensure credit_balances row exists, then update balance
          await client.query(
            `INSERT INTO credit_balances (team_id, balance_microcents) VALUES ($1, 0) ON CONFLICT (team_id) DO NOTHING`,
            [teamId],
          );
          const { rows } = await client.query(
            `UPDATE credit_balances SET balance_microcents = balance_microcents + $1, updated_at = now() WHERE team_id = $2 RETURNING balance_microcents`,
            [creditedMicrocents, teamId],
          );

          // Log transaction
          const txId = `ctx_${crypto.randomUUID().replace(/-/g, '')}`;
          await client.query(
            `INSERT INTO credit_transactions (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents) VALUES ($1, $2, $3, 'purchase', $4, $5, $6)`,
            [txId, teamId, creditedMicrocents, purchaseId, `Credit purchase: $${(creditedMicrocents / 1_000_000 / 100).toFixed(2)}`, Number(rows[0]?.balance_microcents ?? 0)],
          );
          await markCreditApplied(paymentIntentId);

          break; // Don't fall through to subscription handling
        }

        const teamId = session.metadata?.team_id;
        const subscriptionId = session.subscription as string;

        if (!teamId || !subscriptionId) {
          console.error('checkout.session.completed missing team_id or subscription', { teamId, subscriptionId });
          break;
        }

        const subscription = await stripe.subscriptions.retrieve(subscriptionId) as any;
        // Find the flat-price item (not metered)
        const flatItem = subscription.items.data.find(
          (item: any) => item.price.recurring?.usage_type !== 'metered'
        );
        const priceId = flatItem?.price.id ?? subscription.items.data[0]?.price?.id;
        if (!priceId) {
          // A subscription with no resolvable price id can't be mapped to a plan.
          // Skip (and consume the event) rather than throwing — a throw here 500s
          // the webhook and Stripe retries the same unprocessable event forever.
          console.error('checkout.session.completed: subscription has no resolvable price id', {
            subscriptionId,
            itemCount: subscription.items.data.length,
          });
          break;
        }
        const plan = planFromPriceId(priceId);

        // Upsert keyed on team_id, not id: the table has a UNIQUE index on
        // team_id (idx_subscriptions_team, 005-subscriptions.sql:15) as well as
        // PRIMARY KEY (id). A team can already have a row with a DIFFERENT id —
        // from a promo redemption (billing/redeem/route.ts) or a resubscribe/plan
        // migration that mints a new Stripe subscription id — so ON CONFLICT (id)
        // would hit the team_id constraint instead, rollback, and 500 forever
        // (RSH-56). Overwrite the prior row with the real Stripe subscription and
        // clear promo_code_id so the promo claim doesn't shadow the paid plan.
        // Changing id is safe: nothing FKs to subscriptions.id.
        await client.query(
          `INSERT INTO subscriptions (id, team_id, stripe_customer_id, plan, status, current_period_start, current_period_end, cancel_at_period_end)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8)
           ON CONFLICT (team_id) DO UPDATE SET
             id = EXCLUDED.id,
             stripe_customer_id = EXCLUDED.stripe_customer_id,
             plan = EXCLUDED.plan,
             status = EXCLUDED.status,
             current_period_start = EXCLUDED.current_period_start,
             current_period_end = EXCLUDED.current_period_end,
             cancel_at_period_end = EXCLUDED.cancel_at_period_end,
             promo_code_id = NULL,
             updated_at = now()`,
          [
            subscription.id,
            teamId,
            subscription.customer as string,
            plan,
            subscription.status,
            subscription.current_period_start,
            subscription.current_period_end,
            subscription.cancel_at_period_end,
          ],
        );

        await client.query(
          'UPDATE teams SET stripe_customer_id = $1 WHERE id = $2',
          [subscription.customer as string, teamId],
        );
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const subscription = await stripe.subscriptions.retrieve(sub.id) as any;
        // Find the flat-price item (not metered)
        const flatItem = subscription.items.data.find(
          (item: any) => item.price.recurring?.usage_type !== 'metered'
        );
        const priceId = flatItem?.price.id ?? subscription.items.data[0]?.price?.id;
        if (!priceId) {
          // See checkout.session.completed above: skip+consume rather than throw,
          // so an unmappable subscription doesn't trigger endless Stripe retries.
          console.error('customer.subscription.updated: subscription has no resolvable price id', {
            subscriptionId: sub.id,
            itemCount: subscription.items.data.length,
          });
          break;
        }
        const plan = planFromPriceId(priceId);

        const { rowCount } = await client.query(
          `UPDATE subscriptions
           SET plan = $1, status = $2, current_period_start = to_timestamp($3),
               current_period_end = to_timestamp($4), cancel_at_period_end = $5, updated_at = now()
           WHERE id = $6`,
          [
            plan,
            subscription.status,
            subscription.current_period_start,
            subscription.current_period_end,
            subscription.cancel_at_period_end,
            subscription.id,
          ],
        );

        if (rowCount === 0) {
          // No row for this subscription id yet. Under out-of-order webhook
          // delivery a resubscribe's `customer.subscription.updated` can arrive
          // before the `checkout.session.completed` that inserts the row — the
          // resubscribe mints a NEW subscription id, so the old `WHERE id` match
          // misses and the update was silently dropped. Attribute via the Stripe
          // customer and upsert keyed on team_id, exactly like
          // checkout.session.completed (RSH-56), so the latest subscription wins
          // and the update isn't lost.
          const customerId = subscription.customer as string;
          const { rows: teamRows } = await client.query(
            // teams PK is `id` (there is NO teams.team_id column) — alias it so the
            // downstream teamRows[0].team_id binding stays correct. Selecting the
            // nonexistent column 500s on real Postgres (only the test fake hid it).
            'SELECT id AS team_id FROM teams WHERE stripe_customer_id = $1',
            [customerId],
          );
          if (teamRows.length === 0) {
            console.error(
              'subscription.updated: no matching subscription row or team for',
              sub.id,
              customerId,
            );
            break;
          }
          await client.query(
            `INSERT INTO subscriptions (id, team_id, stripe_customer_id, plan, status, current_period_start, current_period_end, cancel_at_period_end)
             VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8)
             ON CONFLICT (team_id) DO UPDATE SET
               id = EXCLUDED.id,
               stripe_customer_id = EXCLUDED.stripe_customer_id,
               plan = EXCLUDED.plan,
               status = EXCLUDED.status,
               current_period_start = EXCLUDED.current_period_start,
               current_period_end = EXCLUDED.current_period_end,
               cancel_at_period_end = EXCLUDED.cancel_at_period_end,
               promo_code_id = NULL,
               updated_at = now()`,
            [
              subscription.id,
              teamRows[0].team_id,
              customerId,
              plan,
              subscription.status,
              subscription.current_period_start,
              subscription.current_period_end,
              subscription.cancel_at_period_end,
            ],
          );
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // LAY-344 Option A: free and pro plans have identical caps
        // (Infinity), so a cancellation no longer requires revoking
        // keys or disabling rules. Just record the canceled status —
        // the team can keep using everything; only savings-share
        // billing stops.
        const sub = event.data.object as Stripe.Subscription;
        const { rowCount } = await client.query(
          `UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE id = $1`,
          [sub.id],
        );
        if (rowCount === 0) {
          console.error('subscription.deleted: no matching subscription row for', sub.id);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId =
          (invoice as any).subscription ?? invoice.parent?.subscription_details?.subscription;
        if (!subscriptionId) {
          console.error('invoice.payment_failed: no subscription ID on invoice');
          break;
        }

        await client.query(
          `UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE id = $1`,
          [subscriptionId],
        );
        break;
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = charge.payment_intent as string;
        if (!paymentIntentId) break;

        // Compute the *incremental* refund amount from this event, not the
        // cumulative charge.amount_refunded. Stripe fires charge.refunded for
        // each partial refund with a distinct event.id, so the idempotency
        // check on event.id already prevents processing the same refund event
        // twice. But charge.amount_refunded is the running total across all
        // refunds on this charge — using it would over-claw on the second
        // partial refund. Instead, find the most recent refund object.
        const refunds = (charge as any).refunds?.data as Array<{ id: string; amount: number }> | undefined;
        const latestRefund = refunds?.[0];
        let amountCents: number;
        if (latestRefund) {
          // The most recent refund is first in the array (Stripe orders desc).
          amountCents = latestRefund.amount;
        } else {
          // Fallback: full refund with no refunds expansion (shouldn't happen
          // in practice since charge.refunded always includes the refund).
          amountCents = charge.amount_refunded ?? charge.amount;
        }
        if (!amountCents || amountCents <= 0) break;

        const origin = await resolveCreditOrigin(paymentIntentId);
        if (!origin) break;
        let parent = await lockCreditPaymentIntent(paymentIntentId, origin);
        parent = await bootstrapCreditApplied(paymentIntentId, parent);
        const beforeMicrocents = await getAvailableCreditMicrocents(paymentIntentId, parent);
        const recorded = await recordRefund(
          paymentIntentId,
          latestRefund?.id ?? event.id,
          amountCents * 1_000_000,
        );
        if (!recorded) break;
        const afterMicrocents = await getAvailableCreditMicrocents(paymentIntentId, parent);
        if (parent.creditApplied) {
          await applyReversalDelta(
            parent.teamId,
            afterMicrocents - beforeMicrocents,
            'refund',
            charge.id,
            `Refund availability adjustment: $${((afterMicrocents - beforeMicrocents) / 1_000_000 / 100).toFixed(2)}`,
          );
        }
        await client.query(`UPDATE teams SET is_suspended = true WHERE id = $1`, [parent.teamId]);
        console.error(`[webhook] charge.refunded: team ${parent.teamId} suspended; available credit changed by $${((afterMicrocents - beforeMicrocents) / 1_000_000 / 100).toFixed(2)}`);
        break;
      }

      // Only handle funds_withdrawn — NOT dispute.created. Stripe fires both
      // events for the same dispute with different event.id values, so the
      // event-level idempotency check would not catch the duplication.
      // dispute.created is an informational event; funds_withdrawn is when the
      // money actually moves. Handling both would double-deduct the dispute amount.
      case 'charge.dispute.funds_withdrawn': {
        const dispute = event.data.object as Stripe.Dispute;
        let paymentIntentId = (dispute as any).payment_intent as string;
        if (!paymentIntentId && dispute.charge) {
          try {
            const ch = await stripe.charges.retrieve(
              typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id,
            );
            paymentIntentId = ch.payment_intent as string;
          } catch (err) {
            console.error('Failed to retrieve charge for dispute', err);
            // Do not commit the stripe_events claim for a transient lookup
            // failure: Stripe must retry rather than losing this reversal.
            throw err;
          }
        }
        if (!paymentIntentId) break;

        const amountCents = dispute.amount;
        if (!amountCents || amountCents <= 0) break;

        const origin = await resolveCreditOrigin(paymentIntentId);
        if (!origin) break;
        let parent = await lockCreditPaymentIntent(paymentIntentId, origin);
        parent = await bootstrapCreditApplied(paymentIntentId, parent);
        const beforeMicrocents = await getAvailableCreditMicrocents(paymentIntentId, parent);
        const recorded = await recordDisputeWithdrawal(
          paymentIntentId,
          dispute.id,
          amountCents * 1_000_000,
        );
        if (!recorded) break;
        const afterMicrocents = await getAvailableCreditMicrocents(paymentIntentId, parent);
        if (parent.creditApplied) {
          await applyReversalDelta(
            parent.teamId,
            afterMicrocents - beforeMicrocents,
            'dispute',
            dispute.id,
            `Dispute availability adjustment: $${((afterMicrocents - beforeMicrocents) / 1_000_000 / 100).toFixed(2)}`,
          );
        }
        await client.query(`UPDATE teams SET is_suspended = true WHERE id = $1`, [parent.teamId]);
        console.error(`[webhook] ${event.type}: team ${parent.teamId} suspended; available credit changed by $${((afterMicrocents - beforeMicrocents) / 1_000_000 / 100).toFixed(2)}`);
        break;
      }

      // Auto-topup backfill (RSH money-path hardening). The proxy auto-topup
      // worker charges a confirmed off-session PaymentIntent and only credits
      // the team AFTER `pi.status === 'succeeded'`. If it crashes in that window
      // the customer is charged with no credit and no re-enqueue. Stripe also
      // fires payment_intent.succeeded here, so we credit idempotently keyed by
      // the PaymentIntent id — the SAME key the worker's addCredits uses. The
      // partial unique index on credit_transactions.idempotency_key makes this
      // exactly-once across BOTH paths: whichever runs first credits, the other
      // no-ops. Only auto-topup PIs need this (checkout credits flow through
      // checkout.session.completed / credit_purchases above).
      case 'payment_intent.succeeded': {
        const pi = event.data.object as Stripe.PaymentIntent;
        if (pi.metadata?.type !== 'auto_topup') break;
        const teamId = pi.metadata?.team_id;
        if (!teamId) break;
        const amountCents = pi.amount_received || pi.amount;
        if (!amountCents || amountCents <= 0) break;
        const microcents = amountCents * 1_000_000;
        let parent = await lockCreditPaymentIntent(pi.id, {
          teamId,
          kind: 'auto_topup',
          amountMicrocents: microcents,
        });
        parent = await bootstrapCreditApplied(pi.id, parent);
        if (parent.creditApplied) break;
        const creditedMicrocents = await getAvailableCreditMicrocents(pi.id, parent);
        const description = creditedMicrocents === parent.amountMicrocents
          ? `auto_topup: $${(parent.amountMicrocents / 1_000_000 / 100).toFixed(2)}`
          : `auto_topup: $${(creditedMicrocents / 1_000_000 / 100).toFixed(2)} after pending reversal`;

        await client.query(
          `INSERT INTO credit_balances (team_id, balance_microcents) VALUES ($1, 0) ON CONFLICT (team_id) DO NOTHING`,
          [teamId],
        );
        // Claim the PaymentIntent id atomically by writing the ledger row first.
        const txId = `ctx_${crypto.randomUUID().replace(/-/g, '')}`;
        const claim = await client.query(
          `INSERT INTO credit_transactions
             (id, team_id, amount_microcents, type, reference_id, description, balance_after_microcents, idempotency_key)
           VALUES ($1, $2, $3, 'auto_topup', $4, $5, 0, $6)
           ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [txId, teamId, creditedMicrocents, pi.id, description, pi.id],
        );
        if (claim.rows.length === 0) {
          // Already credited by the worker (or a prior webhook) — do NOT re-credit.
          await markCreditApplied(pi.id);
          break;
        }
        const { rows } = await client.query(
          `UPDATE credit_balances SET balance_microcents = balance_microcents + $1, updated_at = now() WHERE team_id = $2 RETURNING balance_microcents`,
          [creditedMicrocents, teamId],
        );
        await client.query(
          `UPDATE credit_transactions SET balance_after_microcents = $1 WHERE id = $2`,
          [Number(rows[0]?.balance_microcents ?? creditedMicrocents), txId],
        );
        await markCreditApplied(pi.id);
        // Mirror the worker's own post-charge write (auto-topup-worker.ts) so
        // its 5-minute cooldown check sees this charge — otherwise, if this
        // webhook wins the crash-window race, the worker's next run has no
        // record of it and can fire a second real Stripe charge for the same
        // team before the cooldown would have blocked it.
        await client.query(
          `UPDATE auto_topup_settings SET last_topup_at = now() WHERE team_id = $1`,
          [teamId],
        );
        console.log(`[webhook] payment_intent.succeeded auto_topup backfill: team ${teamId} +$${(creditedMicrocents / 1_000_000 / 100).toFixed(2)}`);
        break;
      }

      // Dispute reinstatement (RSH money-path hardening). The symmetric reversal
      // of charge.dispute.funds_withdrawn: when a dispute is won and Stripe
      // returns the funds, re-credit the clawed-back amount and lift the
      // dispute-driven suspension. Event-level stripe_events dedup makes this
      // once-per-event. NOTE: teams.is_suspended is a single boolean with no
      // reason; this reverses the dispute's own suspension. If multi-reason
      // suspension is ever added, gate the unsuspend on the reason.
      case 'charge.dispute.funds_reinstated': {
        const dispute = event.data.object as Stripe.Dispute;
        let paymentIntentId = (dispute as any).payment_intent as string;
        if (!paymentIntentId && dispute.charge) {
          try {
            const ch = await stripe.charges.retrieve(
              typeof dispute.charge === 'string' ? dispute.charge : dispute.charge.id,
            );
            paymentIntentId = ch.payment_intent as string;
          } catch (err) {
            console.error('Failed to retrieve charge for dispute reinstatement', err);
            // As above, leave the event unclaimed so Stripe retries this
            // balance-affecting transition after the lookup recovers.
            throw err;
          }
        }
        if (!paymentIntentId) break;

        const amountCents = dispute.amount;
        if (!amountCents || amountCents <= 0) break;

        const origin = await resolveCreditOrigin(paymentIntentId);
        if (!origin) break;
        let parent = await lockCreditPaymentIntent(paymentIntentId, origin);
        parent = await bootstrapCreditApplied(paymentIntentId, parent);
        const beforeMicrocents = await getAvailableCreditMicrocents(paymentIntentId, parent);
        const transitioned = await markDisputeReinstated(
          paymentIntentId,
          dispute.id,
          amountCents * 1_000_000,
        );
        if (!transitioned) break;
        const afterMicrocents = await getAvailableCreditMicrocents(paymentIntentId, parent);
        if (parent.creditApplied) {
          await applyReversalDelta(
            parent.teamId,
            afterMicrocents - beforeMicrocents,
            'dispute',
            dispute.id,
            `Dispute reinstatement availability adjustment: +$${((afterMicrocents - beforeMicrocents) / 1_000_000 / 100).toFixed(2)}`,
          );
        }
        // teams.is_suspended has no owner/reason field. Clearing it here could
        // re-enable a team suspended by a refund, administrator, or another
        // PaymentIntent, so a reinstatement restores credit only and leaves
        // suspension resolution to an explicit operator action.
        console.error(`[webhook] ${event.type}: team ${parent.teamId} available credit changed by $${((afterMicrocents - beforeMicrocents) / 1_000_000 / 100).toFixed(2)}; suspension left unchanged`);
        break;
      }

      default:
        console.log(`Unhandled event: ${event.type}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Error processing webhook event ${event.type}:`, err);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  } finally {
    client.release();
  }

  return NextResponse.json({ received: true });
}
