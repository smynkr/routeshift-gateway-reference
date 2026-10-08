import { beforeEach, describe, expect, it, vi } from 'vitest';

// RSH-56 hardening: a team that already has a live, non-promo subscription must
// not be able to open a SECOND Stripe checkout — that creates a duplicate paid
// subscription while the DB (UNIQUE team_id) tracks only one. Mirror the block
// redeem/route.ts already has, but branch already-subscribed admins to the Stripe
// billing portal instead of hard-rejecting. Promo-only and canceled rows must
// still be allowed to start a real checkout (resubscribe / upgrade-from-promo).

const h = vi.hoisted(() => {
  const state: {
    existingSub: { stripe_customer_id: string; status: string } | null;
    teamRow: { id: string; name: string; stripe_customer_id: string | null };
  } = {
    existingSub: null,
    teamRow: { id: 'team_1', name: 'Team One', stripe_customer_id: 'cus_real' },
  };

  const query = async (sql: string) => {
    if (/FROM subscriptions WHERE team_id/i.test(sql)) {
      return { rows: state.existingSub ? [state.existingSub] : [], rowCount: state.existingSub ? 1 : 0 };
    }
    if (/FROM teams WHERE id/i.test(sql)) {
      return { rows: [state.teamRow], rowCount: 1 };
    }
    if (/UPDATE teams/i.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };

  return { state, query };
});

const stripeMock = vi.hoisted(() => ({
  customers: { create: vi.fn(async () => ({ id: 'cus_new' })) },
  checkout: { sessions: { create: vi.fn(async () => ({ url: 'https://checkout.example/session' })) } },
  billingPortal: { sessions: { create: vi.fn(async () => ({ url: 'https://portal.example/session' })) } },
}));

vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('@/lib/stripe', () => ({ stripe: stripeMock }));
vi.mock('@/lib/rbac', () => ({
  requireRole: async () => ({ teamId: 'team_1', userId: 'user_1', role: 'admin' }),
}));
vi.mock('@/lib/demo', () => ({
  isDemoActive: async () => false,
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only',
}));
vi.mock('@/lib/app-origin', () => ({ getRequiredAppOrigin: () => 'https://app.test' }));

import { POST } from '@/app/api/billing/checkout/route';

function jsonReq(body: unknown) {
  return new Request('https://app.test/api/billing/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('billing checkout — already-subscribed guard (RSH-56)', () => {
  beforeEach(() => {
    stripeMock.customers.create.mockClear();
    stripeMock.checkout.sessions.create.mockClear();
    stripeMock.billingPortal.sessions.create.mockClear();
    h.state.existingSub = null;
    h.state.teamRow = { id: 'team_1', name: 'Team One', stripe_customer_id: 'cus_real' };
  });

  it('redirects an already-subscribed team to the billing portal instead of a second checkout', async () => {
    h.state.existingSub = { stripe_customer_id: 'cus_real', status: 'active' };

    const res = await POST(jsonReq({ plan: 'pro' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.portal).toBe(true);
    expect(body.url).toBe('https://portal.example/session');
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: 'cus_real',
      return_url: 'https://app.test/billing',
    });
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('still lets a promo-only team start a real checkout', async () => {
    h.state.existingSub = { stripe_customer_id: 'promo_team_1', status: 'active' };
    h.state.teamRow = { id: 'team_1', name: 'Team One', stripe_customer_id: 'promo_team_1' };

    const res = await POST(jsonReq({ plan: 'pro' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe('https://checkout.example/session');
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('lets a team with a canceled subscription resubscribe via checkout', async () => {
    h.state.existingSub = { stripe_customer_id: 'cus_real', status: 'canceled' };

    const res = await POST(jsonReq({ plan: 'pro' }));

    expect(res.status).toBe(200);
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });

  it('creates a checkout for a brand-new team with no subscription', async () => {
    h.state.existingSub = null;
    h.state.teamRow = { id: 'team_1', name: 'Team One', stripe_customer_id: null };

    const res = await POST(jsonReq({ plan: 'pro' }));

    expect(res.status).toBe(200);
    expect(stripeMock.customers.create).toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(stripeMock.billingPortal.sessions.create).not.toHaveBeenCalled();
  });
});
