import { beforeEach, describe, expect, it, vi } from 'vitest';

// Low-severity follow-up (PR #63): `customer.subscription.updated` did a plain
// `UPDATE ... WHERE id = $sub_id` and, on 0 rows matched, logged and gave up.
// Under out-of-order webhook delivery a resubscribe mints a NEW subscription id,
// so the `updated` event can land before the `checkout.session.completed` that
// inserts the row — the id doesn't match anything yet and the update is lost.
// The fix: when the UPDATE matches no row, attribute via the Stripe customer and
// upsert keyed on team_id (ON CONFLICT (team_id)), mirroring checkout (RSH-56).
//
// The fake DB models the subscriptions UNIQUE(team_id) + PK(id) constraints and
// a teams lookup by stripe_customer_id.

const h = vi.hoisted(() => {
  const subscriptions: Array<Record<string, unknown>> = [];
  // teams PK is `id` (no team_id column) — mirror real Postgres so this fake
  // can't mask a query that selects a nonexistent column.
  const teams: Array<{ id: string; stripe_customer_id: string }> = [];

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
    if (/INSERT INTO stripe_events/i.test(sql)) return { rowCount: 1, rows: [] }; // new event, claimed

    if (/SELECT id AS team_id FROM teams WHERE stripe_customer_id/i.test(sql)) {
      const [customer] = params as string[];
      const t = teams.find((x) => x.stripe_customer_id === customer);
      return { rowCount: t ? 1 : 0, rows: t ? [{ team_id: t.id }] : [] };
    }

    if (/^\s*UPDATE subscriptions/i.test(sql)) {
      // params: [plan, status, cps, cpe, cape, id]
      const id = (params as string[])[5];
      const row = subscriptions.find((r) => r.id === id);
      if (!row) return { rowCount: 0, rows: [] };
      row.plan = (params as string[])[0];
      row.status = (params as string[])[1];
      return { rowCount: 1, rows: [] };
    }

    if (/INSERT INTO subscriptions/i.test(sql)) {
      const target = (sql.match(/ON CONFLICT \(\s*(\w+)\s*\)/i) || [])[1];
      const [id, teamId, customer, plan, status] = params as string[];
      const byTeam = subscriptions.find((r) => r.team_id === teamId);
      const byId = subscriptions.find((r) => r.id === id);

      if (target === 'team_id') {
        // Model the DO UPDATE SET clause faithfully: only clear promo_code_id
        // if the SQL actually sets it to NULL, so the test fails if the fix is
        // dropped (parity with checkout.session.completed).
        const clearsPromo = /promo_code_id\s*=\s*NULL/i.test(sql);
        if (byTeam) {
          byTeam.id = id;
          byTeam.stripe_customer_id = customer;
          byTeam.plan = plan;
          byTeam.status = status;
          if (clearsPromo) byTeam.promo_code_id = null;
          return { rowCount: 1, rows: [] };
        }
        if (byId && byId.team_id !== teamId) throw uniqueViolation('subscriptions_pkey');
        subscriptions.push({
          id,
          team_id: teamId,
          stripe_customer_id: customer,
          plan,
          status,
          promo_code_id: null,
        });
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`fake-db: unexpected ON CONFLICT target: ${String(target)}`);
    }

    return { rowCount: 0, rows: [] };
  };

  return { subscriptions, teams, query, event: null as unknown, subscription: null as unknown };
});

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: async () => ({ query: h.query, release: () => {} }),
  }),
}));

vi.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: { constructEvent: () => h.event },
    subscriptions: { retrieve: async () => h.subscription },
  },
}));

import { POST } from '@/app/api/webhooks/stripe/route';

function setUpdated(subId: string, customer: string, status = 'active') {
  h.event = {
    id: `evt_${subId}`,
    type: 'customer.subscription.updated',
    data: { object: { id: subId } },
  };
  h.subscription = {
    id: subId,
    customer,
    status,
    current_period_start: 1_700_000_000,
    current_period_end: 1_702_592_000,
    cancel_at_period_end: false,
    items: { data: [{ price: { id: 'price_pro', recurring: { usage_type: 'licensed' } } }] },
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

describe('stripe webhook — customer.subscription.updated out-of-order resilience', () => {
  beforeEach(() => {
    h.subscriptions.length = 0;
    h.teams.length = 0;
    h.event = null;
    h.subscription = null;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_PRO_METERED_PRICE_ID = 'price_pro';
  });

  it('updates in place when the row already exists (happy path)', async () => {
    h.subscriptions.push({
      id: 'sub_active',
      team_id: 'team_1',
      stripe_customer_id: 'cus_1',
      plan: 'pro',
      status: 'active',
    });
    setUpdated('sub_active', 'cus_1', 'past_due');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.subscriptions).toHaveLength(1);
    expect(h.subscriptions[0].id).toBe('sub_active');
    expect(h.subscriptions[0].status).toBe('past_due');
  });

  it('upserts onto the existing team row when a resubscribe minted a new id (out-of-order)', async () => {
    // Old (canceled) subscription row + a known customer for the team.
    h.subscriptions.push({
      id: 'sub_old',
      team_id: 'team_1',
      stripe_customer_id: 'cus_1',
      plan: 'pro',
      status: 'canceled',
    });
    h.teams.push({ id:'team_1', stripe_customer_id: 'cus_1' });
    // `updated` for the NEW subscription id arrives before its checkout/created.
    setUpdated('sub_new', 'cus_1', 'active');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.subscriptions).toHaveLength(1);
    // Pre-fix this was a silent no-op (id stayed sub_old / status canceled).
    expect(h.subscriptions[0].id).toBe('sub_new');
    expect(h.subscriptions[0].status).toBe('active');
    expect(h.subscriptions[0].team_id).toBe('team_1');
  });

  it('clears a lingering promo_code_id when upserting onto an existing promo row', async () => {
    // A promo-redeemed team resubscribes to a paid plan; the new-id `updated`
    // lands first. The fallback upsert must clear the promo claim just like
    // checkout.session.completed, so the promo can't shadow the paid plan or
    // block a future redemption.
    h.subscriptions.push({
      id: 'sub_promo',
      team_id: 'team_1',
      stripe_customer_id: 'cus_1',
      plan: 'pro',
      status: 'active',
      promo_code_id: 'promo_1',
    });
    h.teams.push({ id:'team_1', stripe_customer_id: 'cus_1' });
    setUpdated('sub_new', 'cus_1', 'active');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.subscriptions).toHaveLength(1);
    expect(h.subscriptions[0].id).toBe('sub_new');
    expect(h.subscriptions[0].promo_code_id).toBeNull();
  });

  it('inserts a fresh row when the team is known but has no subscription row yet', async () => {
    h.teams.push({ id:'team_2', stripe_customer_id: 'cus_2' });
    setUpdated('sub_fresh', 'cus_2', 'active');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.subscriptions).toHaveLength(1);
    expect(h.subscriptions[0].id).toBe('sub_fresh');
    expect(h.subscriptions[0].team_id).toBe('team_2');
  });

  it('no-ops when neither a subscription row nor a team can be attributed', async () => {
    setUpdated('sub_orphan', 'cus_unknown', 'active');

    const res = await postWebhook();

    expect(res.status).toBe(200); // acknowledged so Stripe stops retrying
    expect(h.subscriptions).toHaveLength(0);
  });
});
