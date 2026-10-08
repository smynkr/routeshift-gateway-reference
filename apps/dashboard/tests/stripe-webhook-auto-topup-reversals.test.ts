import { beforeEach, describe, expect, it, vi } from 'vitest';

// Auto-topup credits can be written by the worker or payment_intent.succeeded,
// while Stripe can deliver refunds/disputes in either order. Model the parent
// PaymentIntent lock plus reversal state, rather than a happy-path-only ledger.
const h = vi.hoisted(() => {
  type Transaction = {
    id: string;
    team_id: string;
    amount_microcents: number;
    type: 'purchase' | 'auto_topup' | 'refund' | 'dispute';
    reference_id: string | null;
    description?: string;
    idempotency_key?: string | null;
    balance_after_microcents?: number;
  };
  type Parent = {
    team_id: string;
    credit_kind: 'purchase' | 'auto_topup';
    amount_microcents: number;
    credit_applied: boolean;
  };
  type Reversal = {
    payment_intent_id: string;
    reversal_id: string;
    kind: 'refund' | 'dispute';
    amount_microcents: number;
    status: 'active' | 'reinstated';
  };
  type PaymentIntent = {
    id: string;
    metadata: { type: string; team_id?: string };
    amount: number;
    amount_received: number;
  };

  const stripeEvents = new Set<string>();
  const creditPurchases: Array<Record<string, unknown>> = [];
  const creditTransactions: Transaction[] = [];
  const creditBalances = new Map<string, number>();
  const teams = new Map<string, { is_suspended: boolean }>();
  const parents = new Map<string, Parent>();
  const reversals = new Map<string, Reversal>();
  const paymentIntents = new Map<string, PaymentIntent>();
  const chargesRetrieve = vi.fn();
  const paymentIntentsRetrieve = vi.fn();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const reversalKey = (paymentIntentId: string, reversalId: string) => `${paymentIntentId}:${reversalId}`;

  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
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

    if (/INSERT INTO credit_purchases/i.test(sql)) {
      const [id, teamId, amountCents, paymentIntentId] = params as [string, string, number, string];
      if (creditPurchases.some((row) => row.stripe_payment_intent_id === paymentIntentId)) {
        return { rowCount: 0, rows: [] };
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

    if (/INSERT INTO credit_payment_intents/i.test(sql)) {
      const [paymentIntentId, teamId, creditKind, amountMicrocents] = params as [
        string,
        string,
        Parent['credit_kind'],
        number,
      ];
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

    if (/SELECT team_id, amount_microcents\s+FROM credit_transactions/i.test(sql)) {
      const [paymentIntentId] = params as [string];
      const tx = creditTransactions.find(
        (row) => row.type === 'auto_topup'
          && (row.reference_id === paymentIntentId || row.idempotency_key === paymentIntentId),
      );
      return {
        rowCount: tx ? 1 : 0,
        rows: tx ? [{ team_id: tx.team_id, amount_microcents: tx.amount_microcents }] : [],
      };
    }

    if (/INSERT INTO credit_payment_reversals/i.test(sql)) {
      const [paymentIntentId, reversalId, amountMicrocents] = params as [string, string, number];
      const key = reversalKey(paymentIntentId, reversalId);
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
      const row = reversals.get(reversalKey(paymentIntentId, reversalId));
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

    if (/SELECT 1 FROM credit_transactions/i.test(sql)) {
      const [teamId, disputeId] = params as [string, string];
      const debit = creditTransactions.find(
        (row) => row.team_id === teamId
          && row.type === 'dispute'
          && row.reference_id === disputeId
          && row.amount_microcents < 0,
      );
      return { rowCount: debit ? 1 : 0, rows: debit ? [{ one: 1 }] : [] };
    }

    if (/INSERT INTO credit_balances/i.test(sql)) {
      const [teamId] = params as [string];
      if (!creditBalances.has(teamId)) creditBalances.set(teamId, 0);
      return { rowCount: 1, rows: [] };
    }

    if (/^\s*UPDATE credit_balances/i.test(sql)) {
      const [amountMicrocents, teamId] = params as [number, string];
      const current = creditBalances.get(teamId);
      if (current === undefined) return { rowCount: 0, rows: [] };
      const delta = /balance_microcents\s*=\s*balance_microcents\s*-\s*\$1/i.test(sql)
        ? -amountMicrocents
        : amountMicrocents;
      const next = current + delta;
      creditBalances.set(teamId, next);
      return { rowCount: 1, rows: [{ balance_microcents: next }] };
    }

    if (/^\s*INSERT INTO credit_transactions/i.test(sql)) {
      const [id, teamId, amountMicrocents] = params as [string, string, number];
      const hardCodedAuto = sql.includes("'auto_topup'");
      const type: Transaction['type'] = hardCodedAuto
        ? 'auto_topup'
        : (params[3] as Transaction['type']);
      const referenceId = String(hardCodedAuto ? params[3] : params[4]);
      const description = String(hardCodedAuto ? params[4] : params[5]);
      const balanceAfterOrIdempotency = hardCodedAuto ? params[5] : params[6];
      const idempotencyKey = type === 'auto_topup' ? String(balanceAfterOrIdempotency) : null;
      if (idempotencyKey && creditTransactions.some((row) => row.idempotency_key === idempotencyKey)) {
        return { rowCount: 0, rows: [] };
      }
      creditTransactions.push({
        id,
        team_id: teamId,
        amount_microcents: amountMicrocents,
        type,
        reference_id: referenceId,
        description,
        idempotency_key: idempotencyKey,
        balance_after_microcents: type === 'auto_topup' ? 0 : Number(balanceAfterOrIdempotency),
      });
      return { rowCount: 1, rows: [{ id }] };
    }

    if (/^\s*UPDATE credit_transactions SET balance_after_microcents/i.test(sql)) {
      const [balanceAfterMicrocents, id] = params as [number, string];
      const row = creditTransactions.find((tx) => tx.id === id);
      if (row) row.balance_after_microcents = balanceAfterMicrocents;
      return { rowCount: row ? 1 : 0, rows: [] };
    }

    if (/^\s*UPDATE teams SET is_suspended/i.test(sql)) {
      const [teamId] = params as [string];
      const team = teams.get(teamId);
      if (!team) return { rowCount: 0, rows: [] };
      team.is_suspended = /is_suspended\s*=\s*true/i.test(sql);
      return { rowCount: 1, rows: [] };
    }

    if (/^\s*UPDATE auto_topup_settings SET last_topup_at/i.test(sql)) return { rowCount: 1, rows: [] };

    return { rowCount: 0, rows: [] };
  };

  return {
    stripeEvents,
    creditPurchases,
    creditTransactions,
    creditBalances,
    teams,
    parents,
    reversals,
    paymentIntents,
    chargesRetrieve,
    paymentIntentsRetrieve,
    queries,
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

function registerPaymentIntent(
  paymentIntentId = 'pi_auto_1',
  teamId = 'team_1',
  amountCents = 2500,
  type = 'auto_topup',
) {
  h.paymentIntents.set(paymentIntentId, {
    id: paymentIntentId,
    metadata: { type, team_id: teamId },
    amount: amountCents,
    amount_received: amountCents,
  });
}

function seedAutoTopUp(paymentIntentId = 'pi_auto_1', teamId = 'team_1', balance = 2_500_000_000) {
  registerPaymentIntent(paymentIntentId, teamId, balance / 1_000_000);
  h.creditTransactions.push({
    id: `ctx_${paymentIntentId}`,
    team_id: teamId,
    amount_microcents: balance,
    type: 'auto_topup',
    reference_id: paymentIntentId,
    idempotency_key: paymentIntentId,
  });
  h.creditBalances.set(teamId, balance);
  h.teams.set(teamId, { is_suspended: false });
}

function setPaymentIntentSucceeded(eventId: string, paymentIntentId = 'pi_auto_1') {
  const pi = h.paymentIntents.get(paymentIntentId)!;
  h.event = { id: eventId, type: 'payment_intent.succeeded', data: { object: pi } };
}

function setCreditsCheckout(eventId: string, paymentIntentId: string, amountCents = 2500, teamId = 'team_1') {
  h.event = {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${eventId}`,
        metadata: { type: 'credits', team_id: teamId },
        payment_status: 'paid',
        amount_total: amountCents,
        payment_intent: paymentIntentId,
      },
    },
  };
}

function setRefund(eventId: string, paymentIntentId = 'pi_auto_1', amountCents = 500) {
  h.event = {
    id: eventId,
    type: 'charge.refunded',
    data: {
      object: {
        id: `ch_${eventId}`,
        payment_intent: paymentIntentId,
        amount: amountCents,
        amount_refunded: amountCents,
        refunds: { data: [{ id: `re_${eventId}`, amount: amountCents }] },
      },
    },
  };
}

function setDispute(
  type: 'charge.dispute.funds_withdrawn' | 'charge.dispute.funds_reinstated',
  eventId: string,
  disputeId: string,
  amountCents = 800,
  paymentIntentId: string | null = 'pi_auto_1',
  charge: string | null = null,
) {
  h.event = {
    id: eventId,
    type,
    data: { object: { id: disputeId, amount: amountCents, payment_intent: paymentIntentId, charge } },
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

describe('stripe webhook — auto-topup refund and dispute reversals', () => {
  beforeEach(() => {
    h.stripeEvents.clear();
    h.creditPurchases.length = 0;
    h.creditTransactions.length = 0;
    h.creditBalances.clear();
    h.teams.clear();
    h.parents.clear();
    h.reversals.clear();
    h.paymentIntents.clear();
    h.queries.length = 0;
    h.chargesRetrieve.mockReset();
    h.paymentIntentsRetrieve.mockReset();
    h.paymentIntentsRetrieve.mockImplementation(async (paymentIntentId: string) => {
      const pi = h.paymentIntents.get(paymentIntentId);
      if (!pi) throw new Error(`unknown PaymentIntent ${paymentIntentId}`);
      return pi;
    });
    h.event = null;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('claws back an auto-topup refund once and suspends the credited team', async () => {
    seedAutoTopUp();
    setRefund('evt_auto_refund_1');

    const first = await postWebhook();
    const second = await postWebhook();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(2_000_000_000);
    expect(h.creditTransactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount_microcents: -500_000_000, type: 'refund' }),
    ]));
    expect(h.teams.get('team_1')?.is_suspended).toBe(true);
    const ledgerLookup = h.queries.find((query) => /FROM credit_transactions/i.test(query.sql));
    expect(ledgerLookup?.sql).toContain("type = 'auto_topup'");
    expect(ledgerLookup?.sql).toContain('reference_id = $1 OR idempotency_key = $1');
    expect(h.queries.some((query) => /FROM credit_payment_intents[\s\S]*FOR UPDATE/i.test(query.sql))).toBe(true);
  });

  it('withholds a refund delivered before auto-topup credit, then backfills only the net amount', async () => {
    registerPaymentIntent();
    h.teams.set('team_1', { is_suspended: false });
    setRefund('evt_auto_refund_before_credit');
    const refunded = await postWebhook();

    setPaymentIntentSucceeded('evt_auto_success_after_refund');
    const credited = await postWebhook();

    expect(refunded.status).toBe(200);
    expect(credited.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(2_000_000_000);
    expect(h.creditTransactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'auto_topup', amount_microcents: 2_000_000_000 }),
    ]));
    expect(h.teams.get('team_1')?.is_suspended).toBe(true);
  });

  it('withholds a checkout refund before credit and applies only the net purchase amount', async () => {
    registerPaymentIntent('pi_credits_before', 'team_3', 1000, 'credits');
    h.teams.set('team_3', { is_suspended: false });
    setRefund('evt_credits_refund_before', 'pi_credits_before', 300);
    const refunded = await postWebhook();

    setCreditsCheckout('evt_credits_checkout_after', 'pi_credits_before', 1000, 'team_3');
    const credited = await postWebhook();

    expect(refunded.status).toBe(200);
    expect(credited.status).toBe(200);
    expect(h.creditBalances.get('team_3')).toBe(700_000_000);
    expect(h.creditPurchases).toHaveLength(1);
    expect(h.teams.get('team_3')?.is_suspended).toBe(true);
  });

  it('withholds a pre-credit dispute and restores availability after funds are reinstated', async () => {
    registerPaymentIntent();
    h.teams.set('team_1', { is_suspended: false });
    setDispute('charge.dispute.funds_withdrawn', 'evt_auto_withdrawn_before_credit', 'dp_auto_1');
    await postWebhook();

    setPaymentIntentSucceeded('evt_auto_success_after_withdrawal');
    await postWebhook();
    expect(h.creditBalances.get('team_1')).toBe(1_700_000_000);
    expect(h.teams.get('team_1')?.is_suspended).toBe(true);

    setDispute('charge.dispute.funds_reinstated', 'evt_auto_reinstated_after_credit', 'dp_auto_1');
    const reinstated = await postWebhook();

    expect(reinstated.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(2_500_000_000);
    // A shared boolean has no suspension owner; a dispute win cannot safely
    // clear an administrator/refund/other-payment suspension automatically.
    expect(h.teams.get('team_1')?.is_suspended).toBe(true);
  });

  it('restores only the availability delta when a partial refund overlaps a dispute', async () => {
    registerPaymentIntent('pi_overlap', 'team_1', 10_000);
    h.teams.set('team_1', { is_suspended: false });
    setRefund('evt_overlap_refund', 'pi_overlap', 3_000);
    await postWebhook();
    setDispute('charge.dispute.funds_withdrawn', 'evt_overlap_withdrawn', 'dp_overlap', 8_000, 'pi_overlap');
    await postWebhook();

    setPaymentIntentSucceeded('evt_overlap_success', 'pi_overlap');
    await postWebhook();
    expect(h.creditBalances.get('team_1')).toBe(0);

    setDispute('charge.dispute.funds_reinstated', 'evt_overlap_reinstated', 'dp_overlap', 8_000, 'pi_overlap');
    await postWebhook();

    // $100 original - $30 permanent refund = $70. Reinstating an $80
    // withdrawal must not recreate the refunded $30.
    expect(h.creditBalances.get('team_1')).toBe(7_000_000_000);
  });

  it('treats reinstatement before withdrawal as net zero and never mints or suspends', async () => {
    registerPaymentIntent();
    h.teams.set('team_1', { is_suspended: false });
    setDispute('charge.dispute.funds_reinstated', 'evt_auto_reinstated_first', 'dp_auto_order');
    await postWebhook();

    setDispute('charge.dispute.funds_withdrawn', 'evt_auto_withdrawn_late', 'dp_auto_order');
    await postWebhook();

    setPaymentIntentSucceeded('evt_auto_success_after_resolved_dispute');
    const credited = await postWebhook();

    expect(credited.status).toBe(200);
    expect(h.creditBalances.get('team_1')).toBe(2_500_000_000);
    expect(h.teams.get('team_1')?.is_suspended).toBe(false);
    expect(h.creditTransactions.filter((row) => row.type === 'dispute')).toHaveLength(0);
  });

  it('resolves a pre-credit dispute through its charge when Stripe omits payment_intent', async () => {
    registerPaymentIntent('pi_auto_from_charge', 'team_2', 1500);
    h.teams.set('team_2', { is_suspended: false });
    h.chargesRetrieve.mockResolvedValueOnce({ id: 'ch_auto_1', payment_intent: 'pi_auto_from_charge' });
    setDispute('charge.dispute.funds_withdrawn', 'evt_auto_dispute_charge', 'dp_auto_charge', 300, null, 'ch_auto_1');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.chargesRetrieve).toHaveBeenCalledWith('ch_auto_1');
    expect(h.teams.get('team_2')?.is_suspended).toBe(true);
  });

  it('rolls back instead of acknowledging a dispute when its charge lookup fails', async () => {
    h.chargesRetrieve.mockRejectedValueOnce(new Error('Stripe unavailable'));
    setDispute('charge.dispute.funds_withdrawn', 'evt_auto_dispute_lookup_failure', 'dp_auto_failure', 300, null, 'ch_unavailable');

    const res = await postWebhook();

    expect(res.status).toBe(500);
    expect(h.queries.some((query) => query.sql === 'ROLLBACK')).toBe(true);
    expect(h.creditTransactions).toHaveLength(0);
  });
});
