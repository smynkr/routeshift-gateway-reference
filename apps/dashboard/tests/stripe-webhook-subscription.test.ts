import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-56 regression: the checkout.session.completed subscription branch upserted
// with `ON CONFLICT (id) DO NOTHING`, but the subscriptions table also has a
// UNIQUE index on team_id (idx_subscriptions_team, 005-subscriptions.sql:15). When
// a row already exists for the team with a DIFFERENT id (promo redemption, or a
// resubscribe with a new Stripe subscription id), the INSERT raises a UNIQUE(team_id)
// violation that ON CONFLICT (id) does not absorb -> rollback -> permanent HTTP 500,
// so a charged customer never gets provisioned.
//
// The fake DB below models BOTH unique constraints and real Postgres
// `INSERT ... ON CONFLICT (col)` semantics: a conflict target only absorbs
// collisions on that one constraint; any other unique violation still throws 23505.
// This makes the test fail against the buggy code for the same reason production does.

const h = vi.hoisted(() => {
  const store: Array<Record<string, unknown>> = [];

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
    if (/UPDATE teams/i.test(sql)) return { rowCount: 1, rows: [] };

    if (/INSERT INTO subscriptions/i.test(sql)) {
      const target = (sql.match(/ON CONFLICT \(\s*(\w+)\s*\)/i) || [])[1];
      const [id, teamId, customer, plan, status] = params as string[];
      const byTeam = store.find((r) => r.team_id === teamId);
      const byId = store.find((r) => r.id === id);
      const fresh = () => ({
        id,
        team_id: teamId,
        stripe_customer_id: customer,
        plan,
        status,
        promo_code_id: null,
      });

      if (target === 'id') {
        // ON CONFLICT (id) absorbs id collisions only. A pre-existing row for the
        // same team with a different id is a UNIQUE(team_id) violation it can't catch.
        if (byTeam && byTeam.id !== id) throw uniqueViolation('idx_subscriptions_team');
        if (byId) return { rowCount: 0, rows: [] }; // DO NOTHING
        store.push(fresh());
        return { rowCount: 1, rows: [] };
      }

      if (target === 'team_id') {
        if (byTeam) {
          // DO UPDATE SET id = EXCLUDED.id, ..., promo_code_id = NULL
          byTeam.id = id;
          byTeam.stripe_customer_id = customer;
          byTeam.plan = plan;
          byTeam.status = status;
          byTeam.promo_code_id = null;
          return { rowCount: 1, rows: [] };
        }
        if (byId && byId.team_id !== teamId) throw uniqueViolation('subscriptions_pkey');
        store.push(fresh());
        return { rowCount: 1, rows: [] };
      }

      throw new Error(`fake-db: unexpected ON CONFLICT target: ${String(target)}`);
    }

    return { rowCount: 0, rows: [] };
  };

  return { store, query, event: null as unknown, subscription: null as unknown };
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

function setCheckout(teamId: string, subId: string, customer: string) {
  h.event = {
    id: `evt_${subId}`,
    type: 'checkout.session.completed',
    data: { object: { metadata: { team_id: teamId }, subscription: subId } },
  };
  h.subscription = {
    id: subId,
    customer,
    status: 'active',
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

describe('stripe webhook — checkout.session.completed subscription upsert (RSH-56)', () => {
  beforeEach(() => {
    h.store.length = 0;
    h.event = null;
    h.subscription = null;
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    process.env.STRIPE_PRO_METERED_PRICE_ID = 'price_pro';
  });

  it('provisions the plan when the team already redeemed a promo (existing row, different id)', async () => {
    h.store.push({
      id: 'sub_promoabc',
      team_id: 'team_1',
      stripe_customer_id: 'promo_team_1',
      plan: 'pro',
      status: 'active',
      promo_code_id: 'promo_1',
    });
    setCheckout('team_1', 'sub_realStripe999', 'cus_real');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.store).toHaveLength(1);
    expect(h.store[0].id).toBe('sub_realStripe999');
    expect(h.store[0].team_id).toBe('team_1');
    expect(h.store[0].stripe_customer_id).toBe('cus_real');
    expect(h.store[0].promo_code_id).toBeNull(); // promo claim cleared on real purchase
  });

  it('upserts on resubscribe when an old subscription row exists with a different id', async () => {
    h.store.push({
      id: 'sub_old',
      team_id: 'team_1',
      stripe_customer_id: 'cus_old',
      plan: 'pro',
      status: 'canceled',
      promo_code_id: null,
    });
    setCheckout('team_1', 'sub_new', 'cus_old');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.store).toHaveLength(1);
    expect(h.store[0].id).toBe('sub_new');
    expect(h.store[0].status).toBe('active');
  });

  it('inserts a new subscription row for a team that has none (happy path unaffected)', async () => {
    setCheckout('team_2', 'sub_fresh', 'cus_fresh');

    const res = await postWebhook();

    expect(res.status).toBe(200);
    expect(h.store).toHaveLength(1);
    expect(h.store[0].id).toBe('sub_fresh');
    expect(h.store[0].team_id).toBe('team_2');
  });
});
