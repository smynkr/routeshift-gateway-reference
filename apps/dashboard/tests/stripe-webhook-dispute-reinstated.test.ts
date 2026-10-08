import { beforeEach, describe, expect, it, vi } from 'vitest';

// Dispute funds reinstatement is live-money reversal code. This fake models the
// event-level stripe_events claim plus the credit_purchases lookup that ties a
// Stripe PaymentIntent back to a team before any balance or suspension mutation.

const h = vi.hoisted(() => {
  const stripeEvents = new Set<string>();
  const creditPurchases: Array<Record<string, unknown>> = [];
  const creditBalances = new Map<string, number>();
  const creditTransactions: Array<Record<string, unknown>> = [];
  const teams = new Map<string, { is_suspended: boolean }>();
  const parents = new Map<string, {
    team_id: string;
    credit_kind: string;
    amount_microcents: number;
    credit_applied: boolean;
  }>();
  const reversals = new Map<string, {
    payment_intent_id: string;
    reversal_id: string;
    kind: 'refund' | 'dispute';
    amount_microcents: number;
    status: 'active' | 'reinstated';
  }>();
  const chargesRetrieve = vi.fn();
  const paymentIntentsRetrieve = vi.fn();

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
      const [paymentIntentId] = params as string[];
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

    if (/INSERT INTO credit_payment_reversals/i.test(sql)) {
      const [paymentIntentId, reversalId, amountMicrocents] = params as [string, string, number];
      const key = `${paymentIntentId}:${reversalId}`;
      if (reversals.has(key)) return { rowCount: 0, rows: [] };
      reversals.set(key, {
        payment_intent_id: paymentIntentId,
        reversal_id: reversalId,
        kind: sql.includes("'refund'") ? 'refund' : 'dispute',
        amount_microcents: amountMicrocents,
        status: sql.includes("'reinstated'") ? 'reinstated' : 'active',
      });
      return { rowCount: 1, rows: [{ reversal_id: reversalId }] };
    }

    if (/UPDATE credit_payment_reversals/i.test(sql)) {
      const [paymentIntentId, reversalId] = params as [string, string];
      const row = reversals.get(`${paymentIntentId}:${reversalId}`);
      if (!row || row.status !== 'active') return { rowCount: 0, rows: [] };
      row.status = 'reinstated';
      return { rowCount: 1, rows: [{ reversal_id: reversalId }] };
    }

    if (/FROM credit_payment_reversals/i.test(sql)) {
      const [paymentIntentId] = params as [string];
      const withheldMicrocents = [...reversals.values()]
        .filter((row) => row.payment_intent_id === paymentIntentId)
        .filter((row) => row.kind === 'refund' || row.status === 'active')
        .reduce((sum, row) => sum + row.amount_microcents, 0);
      return { rowCount: 1, rows: [{ withheld_microcents: withheldMicrocents }] };
    }

    if (/^\s*UPDATE credit_balances/i.test(sql)) {
      const [amountMicrocents, teamId] = params as [number, string];
      if (!creditBalances.has(teamId)) return { rowCount: 0, rows: [] };
      const nextBalance = (creditBalances.get(teamId) ?? 0) + amountMicrocents;
      creditBalances.set(teamId, nextBalance);
      return { rowCount: 1, rows: [{ balance_microcents: nextBalance }] };
    }

    if (/^\s*INSERT INTO credit_transactions/i.test(sql)) {
      const [id, teamId, amountMicrocents, type, referenceId, description, balanceAfterMicrocents] = params as [
        string,
        string,
        number,
        string,
        string,
        string,
        number,
      ];
      if (creditTransactions.some((row) => row.id === id)) {
        throw uniqueViolation('credit_transactions_pkey');
      }
      creditTransactions.push({
        id,
        team_id: teamId,
        amount_microcents: amountMicrocents,
        type: type as 'dispute',
        reference_id: referenceId,
        description,
        balance_after_microcents: balanceAfterMicrocents,
      });
      return { rowCount: 1, rows: [] };
    }

    if (/^\s*UPDATE teams SET is_suspended = false/i.test(sql)) {
      const [teamId] = params as string[];
      const team = teams.get(teamId);
      if (!team) return { rowCount: 0, rows: [] };
      team.is_suspended = false;
      return { rowCount: 1, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  };

  return {
    stripeEvents,
    creditPurchases,
    creditBalances,
    creditTransactions,
    teams,
    parents,
    reversals,
    chargesRetrieve,
    paymentIntentsRetrieve,
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
    charges: { retrieve: h.chargesRetrieve },
    paymentIntents: { retrieve: h.paymentIntentsRetrieve },
  },
}));

import { POST } from '@/app/api/webhooks/stripe/route';

function setDispute(
  type: 'charge.dispute.funds_withdrawn' | 'charge.dispute.funds_reinstated',
  eventId: string,
  disputeId: string,
  amountCents = 1200,
  paymentIntentId: string | null = 'pi_purchase_1',
  charge: string | null = null,
) {
  h.event = {
    id: eventId,
    type,
    data: {
      object: {
        id: disputeId,
        amount: amountCents,
        payment_intent: paymentIntentId,
        charge,
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

describe('stripe webhook — charge.dispute.funds_reinstated', () => {
  beforeEach(() => {
    h.stripeEvents.clear();
    h.creditPurchases.length = 0;
    h.creditBalances.clear();
    h.creditTransactions.length = 0;
    h.teams.clear();
    h.parents.clear();
    h.reversals.clear();
    h.chargesRetrieve.mockReset();
    h.paymentIntentsRetrieve.mockReset();
    // An unknown normal checkout is not an auto-topup and must remain a
    // harmless no-op; pre-credit auto-topups are exercised in their own suite.
    h.paymentIntentsRetrieve.mockResolvedValue({ metadata: { type: 'credits' }, amount: 1200, amount_received: 1200 });
    h.event = null;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('restores a prior dispute delta without clearing the shared suspension flag', async () => {
    h.creditPurchases.push({
      id: 'cpurch_1',
      team_id: 'team_1',
      amount_cents: 5000,
      stripe_payment_intent_id: 'pi_purchase_1',
      status: 'completed',
    });
    h.creditBalances.set('team_1', 800_000_000);
    h.teams.set('team_1', { is_suspended: true });
    setDispute('charge.dispute.funds_withdrawn', 'evt_dispute_withdrawn_1', 'dp_1', 1200, 'pi_purchase_1');
    const withdrawn = await postWebhook();
    expect(withdrawn.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(-400_000_000);

    setDispute('charge.dispute.funds_reinstated', 'evt_dispute_reinstated_1', 'dp_1', 1200, 'pi_purchase_1');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(800_000_000);
    expect(h.creditTransactions).toHaveLength(2);
    expect(h.creditTransactions[1]).toMatchObject({
      team_id: 'team_1',
      amount_microcents: 1_200_000_000,
      type: 'dispute',
      reference_id: 'dp_1',
      balance_after_microcents: 800_000_000,
    });
    expect(h.teams.get('team_1')?.is_suspended).toBe(true);
  });

  it('no-ops when the PaymentIntent has no credit purchase row', async () => {
    h.creditBalances.set('team_1', 800_000_000);
    h.teams.set('team_1', { is_suspended: true });
    h.paymentIntentsRetrieve.mockResolvedValueOnce({ metadata: { type: 'other' }, amount: 1200, amount_received: 1200 });
    setDispute('charge.dispute.funds_reinstated', 'evt_dispute_orphan', 'dp_orphan', 1200, 'pi_unknown');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(800_000_000);
    expect(h.creditTransactions).toHaveLength(0);
    expect(h.teams.get('team_1')?.is_suspended).toBe(true);
  });

  it('resolves the PaymentIntent from the charge when the dispute object omits it', async () => {
    h.creditPurchases.push({
      id: 'cpurch_charge_lookup',
      team_id: 'team_2',
      amount_cents: 3000,
      stripe_payment_intent_id: 'pi_from_charge',
      status: 'completed',
    });
    h.creditBalances.set('team_2', 100_000_000);
    h.teams.set('team_2', { is_suspended: true });
    h.chargesRetrieve.mockResolvedValueOnce({ id: 'ch_1', payment_intent: 'pi_from_charge' });
    setDispute('charge.dispute.funds_withdrawn', 'evt_dispute_charge_lookup_withdrawn', 'dp_charge_lookup', 700, null, 'ch_1');
    await postWebhook();
    h.chargesRetrieve.mockResolvedValueOnce({ id: 'ch_1', payment_intent: 'pi_from_charge' });
    setDispute('charge.dispute.funds_reinstated', 'evt_dispute_charge_lookup', 'dp_charge_lookup', 700, null, 'ch_1');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.chargesRetrieve).toHaveBeenCalledWith('ch_1');
    expect(h.creditBalances.get('team_2')).toBe(100_000_000);
    expect(h.creditTransactions).toHaveLength(2);
    expect(h.creditTransactions[1]).toMatchObject({
      team_id: 'team_2',
      amount_microcents: 700_000_000,
      type: 'dispute',
      reference_id: 'dp_charge_lookup',
      balance_after_microcents: 100_000_000,
    });
    expect(h.teams.get('team_2')?.is_suspended).toBe(true);
  });
});
