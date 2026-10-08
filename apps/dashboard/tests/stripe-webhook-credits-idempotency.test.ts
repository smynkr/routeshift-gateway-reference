import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-90 regression: Stripe can send distinct Event objects for the same
// underlying checkout transition. The outer stripe_events(event_id) claim accepts
// the new event id, but credit_purchases has UNIQUE(stripe_payment_intent_id).
// Duplicate payment intents must commit the event claim and skip ledger mutation.

const h = vi.hoisted(() => {
  const stripeEvents = new Set<string>();
  const creditPurchases: Array<Record<string, unknown>> = [];
  const creditBalances = new Map<string, number>();
  const creditTransactions: Array<Record<string, unknown>> = [];
  const parents = new Map<string, {
    team_id: string;
    credit_kind: string;
    amount_microcents: number;
    credit_applied: boolean;
  }>();

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

    if (/FROM credit_purchases/i.test(sql)) {
      const [paymentIntentId] = params as [string];
      const purchase = creditPurchases.find((row) => row.stripe_payment_intent_id === paymentIntentId);
      return {
        rowCount: purchase ? 1 : 0,
        rows: purchase ? [{ team_id: purchase.team_id, amount_cents: purchase.amount_cents }] : [],
      };
    }

    if (/INSERT INTO credit_payment_intents/i.test(sql)) {
      const [paymentIntentId, teamId, creditKind, amountMicrocents] = params as [string, string, string, number];
      if (!parents.has(paymentIntentId)) {
        parents.set(paymentIntentId, {
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
      const parent = parents.get(paymentIntentId);
      return { rowCount: parent ? 1 : 0, rows: parent ? [parent] : [] };
    }

    if (/UPDATE credit_payment_intents/i.test(sql)) {
      const [paymentIntentId] = params as [string];
      const parent = parents.get(paymentIntentId);
      if (parent) parent.credit_applied = true;
      return { rowCount: parent ? 1 : 0, rows: [] };
    }

    if (/FROM credit_payment_reversals/i.test(sql)) {
      return { rowCount: 1, rows: [{ withheld_microcents: 0 }] };
    }

    if (/INSERT INTO credit_purchases/i.test(sql)) {
      const target = (sql.match(/ON CONFLICT \(\s*(\w+)\s*\)/i) || [])[1];
      const [id, teamId, amountCents, paymentIntentId] = params as [string, string, number, string];
      const byPaymentIntent = creditPurchases.find((row) => row.stripe_payment_intent_id === paymentIntentId);

      if (byPaymentIntent) {
        if (target === 'stripe_payment_intent_id') return { rowCount: 0, rows: [] };
        throw uniqueViolation('credit_purchases_stripe_payment_intent_id_key');
      }

      creditPurchases.push({
        id,
        team_id: teamId,
        amount_cents: amountCents,
        stripe_payment_intent_id: paymentIntentId,
        status: 'completed',
      });
      return { rowCount: 1, rows: [] };
    }

    if (/INSERT INTO credit_balances/i.test(sql)) {
      const [teamId] = params as string[];
      if (!creditBalances.has(teamId)) creditBalances.set(teamId, 0);
      return { rowCount: 1, rows: [] };
    }

    if (/^\s*UPDATE credit_balances/i.test(sql)) {
      const [amountMicrocents, teamId] = params as [number, string];
      const nextBalance = (creditBalances.get(teamId) ?? 0) + amountMicrocents;
      creditBalances.set(teamId, nextBalance);
      return { rowCount: 1, rows: [{ balance_microcents: nextBalance }] };
    }

    if (/INSERT INTO credit_transactions/i.test(sql)) {
      const [id, teamId, amountMicrocents, referenceId, description, balanceAfterMicrocents] = params as [
        string,
        string,
        number,
        string,
        string,
        number,
      ];
      creditTransactions.push({
        id,
        team_id: teamId,
        amount_microcents: amountMicrocents,
        type: 'purchase',
        reference_id: referenceId,
        description,
        balance_after_microcents: balanceAfterMicrocents,
      });
      return { rowCount: 1, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  };

  return {
    stripeEvents,
    creditPurchases,
    creditBalances,
    creditTransactions,
    parents,
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
  },
}));

import { POST } from '@/app/api/webhooks/stripe/route';

function setCreditsCheckout(eventId: string, paymentIntentId: string) {
  h.event = {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${eventId}`,
        metadata: { type: 'credits', team_id: 'team_1' },
        payment_status: 'paid',
        amount_total: 2500,
        payment_intent: paymentIntentId,
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

describe('stripe webhook — credits checkout payment_intent idempotency (RSH-90)', () => {
  beforeEach(() => {
    h.stripeEvents.clear();
    h.creditPurchases.length = 0;
    h.creditBalances.clear();
    h.creditTransactions.length = 0;
    h.parents.clear();
    h.event = null;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('credits once and treats a second distinct event for the same payment_intent as handled', async () => {
    setCreditsCheckout('evt_credit_first', 'pi_same_transition');

    const first = await postWebhook();

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true });
    expect(h.creditBalances.get('team_1')).toBe(2_500_000_000);
    expect(h.creditPurchases).toHaveLength(1);
    expect(h.creditTransactions).toHaveLength(1);

    setCreditsCheckout('evt_credit_second', 'pi_same_transition');

    const second = await postWebhook();

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(h.stripeEvents.has('evt_credit_second')).toBe(true);
    expect(h.creditBalances.get('team_1')).toBe(2_500_000_000);
    expect(h.creditPurchases).toHaveLength(1);
    expect(h.creditTransactions).toHaveLength(1);
  });
});
