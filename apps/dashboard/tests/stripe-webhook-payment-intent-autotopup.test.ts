import { beforeEach, describe, expect, it, vi } from 'vitest';

// Auto-topup PaymentIntent backfill: Stripe can deliver a distinct Event object
// for the same underlying PaymentIntent, and the proxy worker can also credit
// first. The fake DB models stripe_events(event_id), credit_balances(team_id),
// credit_transactions(id) PK, and the partial unique index on
// credit_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL.

const h = vi.hoisted(() => {
  const stripeEvents = new Set<string>();
  const creditBalances = new Map<string, number>();
  const creditTransactions: Array<Record<string, unknown>> = [];
  const autoTopupPaymentIntents = new Map<string, {
    team_id: string;
    credit_kind: string;
    amount_microcents: number;
    credit_applied: boolean;
  }>();
  const autoTopupLastStamped = new Map<string, boolean>();

  const uniqueViolation = (constraint: string) => {
    const e = new Error(`duplicate key value violates unique constraint "${constraint}"`) as Error & {
      code: string;
      constraint: string;
    };
    e.code = '23505';
    e.constraint = constraint;
    return e;
  };

  const query = async (sql: string, params: unknown[] = []) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rowCount: 0, rows: [] };

    if (/INSERT INTO stripe_events/i.test(sql)) {
      const [eventId] = params as string[];
      if (stripeEvents.has(eventId)) return { rowCount: 0, rows: [] };
      stripeEvents.add(eventId);
      return { rowCount: 1, rows: [] };
    }

    if (/INSERT INTO credit_payment_intents/i.test(sql)) {
      const [paymentIntentId, teamId, creditKind, amountMicrocents] = params as [string, string, string, number];
      if (!autoTopupPaymentIntents.has(paymentIntentId)) {
        autoTopupPaymentIntents.set(paymentIntentId, {
          team_id: teamId,
          credit_kind: creditKind,
          amount_microcents: amountMicrocents,
          credit_applied: false,
        });
      }
      return { rowCount: 1, rows: [] };
    }

    if (/FROM credit_payment_intents/i.test(sql)) {
      const [paymentIntentId] = params as [string];
      const row = autoTopupPaymentIntents.get(paymentIntentId);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }

    if (/FROM credit_payment_reversals/i.test(sql)) {
      return { rowCount: 1, rows: [{ withheld_microcents: 0 }] };
    }

    if (/SELECT team_id, amount_microcents\s+FROM credit_transactions/i.test(sql)) {
      const [paymentIntentId] = params as [string];
      const row = creditTransactions.find(
        (tx) => tx.type === 'auto_topup'
          && (tx.reference_id === paymentIntentId || tx.idempotency_key === paymentIntentId),
      );
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }

    if (/UPDATE credit_payment_intents/i.test(sql)) {
      const [paymentIntentId] = params as [string];
      const row = autoTopupPaymentIntents.get(paymentIntentId);
      if (row) row.credit_applied = true;
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    if (/INSERT INTO credit_balances/i.test(sql)) {
      const [teamId] = params as string[];
      if (creditBalances.has(teamId)) return { rowCount: 0, rows: [] };
      creditBalances.set(teamId, 0);
      return { rowCount: 1, rows: [] };
    }

    if (/^\s*INSERT INTO credit_transactions/i.test(sql)) {
      const target = (sql.match(/ON CONFLICT \(\s*(\w+)\s*\)/i) || [])[1];
      const isPartialIdempotencyTarget =
        target === 'idempotency_key' && /WHERE\s+idempotency_key\s+IS\s+NOT\s+NULL/i.test(sql);
      const [id, teamId, amountMicrocents, referenceId, description, idempotencyKey] = params as [
        string,
        string,
        number,
        string,
        string,
        string | null,
      ];
      const byId = creditTransactions.find((row) => row.id === id);
      const byIdempotencyKey =
        idempotencyKey == null
          ? undefined
          : creditTransactions.find((row) => row.idempotency_key === idempotencyKey);

      if (byId) throw uniqueViolation('credit_transactions_pkey');
      if (byIdempotencyKey) {
        if (isPartialIdempotencyTarget) return { rowCount: 0, rows: [] };
        throw uniqueViolation('credit_transactions_idempotency_key_uniq');
      }

      creditTransactions.push({
        id,
        team_id: teamId,
        amount_microcents: amountMicrocents,
        type: 'auto_topup',
        reference_id: referenceId,
        description,
        balance_after_microcents: 0,
        idempotency_key: idempotencyKey,
      });
      return { rowCount: 1, rows: [{ id }] };
    }

    if (/^\s*UPDATE credit_balances/i.test(sql)) {
      const [amountMicrocents, teamId] = params as [number, string];
      if (!creditBalances.has(teamId)) return { rowCount: 0, rows: [] };
      const nextBalance = (creditBalances.get(teamId) ?? 0) + amountMicrocents;
      creditBalances.set(teamId, nextBalance);
      return { rowCount: 1, rows: [{ balance_microcents: nextBalance }] };
    }

    if (/^\s*UPDATE credit_transactions SET balance_after_microcents/i.test(sql)) {
      const [balanceAfterMicrocents, id] = params as [number, string];
      const row = creditTransactions.find((tx) => tx.id === id);
      if (!row) return { rowCount: 0, rows: [] };
      row.balance_after_microcents = balanceAfterMicrocents;
      return { rowCount: 1, rows: [] };
    }

    if (/^\s*UPDATE auto_topup_settings SET last_topup_at/i.test(sql)) {
      const [teamId] = params as [string];
      autoTopupLastStamped.set(teamId, true);
      return { rowCount: 1, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  };

  return {
    stripeEvents,
    creditBalances,
    creditTransactions,
    autoTopupPaymentIntents,
    autoTopupLastStamped,
    query,
    event: null as unknown,
  };
});

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: async () => ({ query: h.query, release: () => {} }),
  }),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: { constructEvent: () => h.event },
    subscriptions: { retrieve: vi.fn() },
    charges: { retrieve: vi.fn() },
  },
}));

import { POST } from '@/app/api/webhooks/stripe/route';

function setPaymentIntentSucceeded(
  eventId: string,
  paymentIntentId: string,
  metadata: Record<string, string> = { type: 'auto_topup', team_id: 'team_1' },
  amountReceived = 2500,
) {
  h.event = {
    id: eventId,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: paymentIntentId,
        metadata,
        amount_received: amountReceived,
        amount: amountReceived,
      },
    },
  };
}

function postWebhook() {
  return POST(
    new Request('https://app.test/api/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'raw-body',
    }),
  );
}

describe('stripe webhook — payment_intent.succeeded auto-topup backfill', () => {
  beforeEach(() => {
    h.stripeEvents.clear();
    h.creditBalances.clear();
    h.creditTransactions.length = 0;
    h.autoTopupPaymentIntents.clear();
    h.autoTopupLastStamped.clear();
    h.event = null;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('credits auto-topup PaymentIntents in Stripe cents and records the post-update balance', async () => {
    setPaymentIntentSucceeded('evt_pi_auto_first', 'pi_auto_1');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(h.creditBalances.get('team_1')).toBe(2_500_000_000);
    expect(h.creditTransactions).toHaveLength(1);
    expect(h.creditTransactions[0]).toMatchObject({
      team_id: 'team_1',
      amount_microcents: 2_500_000_000,
      type: 'auto_topup',
      reference_id: 'pi_auto_1',
      idempotency_key: 'pi_auto_1',
      balance_after_microcents: 2_500_000_000,
    });
    // Mirrors the worker's own post-charge write so the worker's 5-minute
    // cooldown check (keyed off last_topup_at) sees this webhook-won charge —
    // otherwise the worker could fire a second real Stripe charge for the
    // same team before the cooldown would have blocked it.
    expect(h.autoTopupLastStamped.get('team_1')).toBe(true);
  });

  it('does not re-credit the same PaymentIntent under a distinct Stripe event id', async () => {
    setPaymentIntentSucceeded('evt_pi_auto_delivery_1', 'pi_auto_same');
    await postWebhook();

    setPaymentIntentSucceeded('evt_pi_auto_delivery_2', 'pi_auto_same');
    const second = await postWebhook();

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true });
    expect(h.stripeEvents.has('evt_pi_auto_delivery_2')).toBe(true);
    expect(h.creditBalances.get('team_1')).toBe(2_500_000_000);
    expect(h.creditTransactions).toHaveLength(1);
  });

  it('no-ops when the proxy worker already inserted the idempotency-keyed ledger row', async () => {
    h.creditBalances.set('team_1', 7_000_000_000);
    h.creditTransactions.push({
      id: 'ctx_worker_first',
      team_id: 'team_1',
      amount_microcents: 2_500_000_000,
      type: 'auto_topup',
      reference_id: 'pi_worker_first',
      description: 'worker auto_topup',
      balance_after_microcents: 7_000_000_000,
      idempotency_key: 'pi_worker_first',
    });
    setPaymentIntentSucceeded('evt_pi_worker_replay', 'pi_worker_first');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(7_000_000_000);
    expect(h.creditTransactions).toHaveLength(1);
    // The worker already claimed and stamped this charge itself — the webhook
    // no-op path must not touch auto_topup_settings again.
    expect(h.autoTopupLastStamped.has('team_1')).toBe(false);
  });

  it('does not re-credit a legacy reference-only auto-topup ledger row', async () => {
    h.creditBalances.set('team_1', 7_000_000_000);
    h.creditTransactions.push({
      id: 'ctx_legacy_first',
      team_id: 'team_1',
      amount_microcents: 2_500_000_000,
      type: 'auto_topup',
      reference_id: 'pi_legacy_first',
      description: 'legacy auto_topup',
      balance_after_microcents: 7_000_000_000,
      idempotency_key: null,
    });
    setPaymentIntentSucceeded('evt_pi_legacy_replay', 'pi_legacy_first');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(7_000_000_000);
    expect(h.creditTransactions).toHaveLength(1);
    expect(h.autoTopupLastStamped.has('team_1')).toBe(false);
  });

  it('ignores PaymentIntents that are not auto-topups', async () => {
    setPaymentIntentSucceeded('evt_pi_plain', 'pi_plain', { type: 'credits', team_id: 'team_1' });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.creditBalances.has('team_1')).toBe(false);
    expect(h.creditTransactions).toHaveLength(0);
  });

  it('ignores auto-topup PaymentIntents without a team id', async () => {
    setPaymentIntentSucceeded('evt_pi_missing_team', 'pi_missing_team', { type: 'auto_topup' });

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.creditBalances.size).toBe(0);
    expect(h.creditTransactions).toHaveLength(0);
  });
});
