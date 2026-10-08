import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' },
  query: vi.fn(),
  customerRetrieve: vi.fn(),
  customerCreate: vi.fn(),
  setupIntentCreate: vi.fn(),
  paymentMethodRetrieve: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: h.query }),
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: async () => h.member,
  requireRole: async () => h.member,
}));

vi.mock('@/lib/demo', () => ({
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only',
  getEffectiveTeamId: async (teamId: string) => teamId,
  isDemoActive: async () => false,
}));

vi.mock('@/lib/stripe', () => ({
  stripe: {
    customers: {
      create: h.customerCreate,
      retrieve: h.customerRetrieve,
    },
    setupIntents: {
      create: h.setupIntentCreate,
    },
    paymentMethods: { retrieve: h.paymentMethodRetrieve },
  },
}));

import { DELETE, GET, POST } from '@/app/api/credits/auto-topup/route';
import { POST as CONFIRM } from '@/app/api/credits/auto-topup/confirm/route';

function jsonReq(path: string, body: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('auto top-up settings route', () => {
  beforeEach(() => {
    h.query.mockReset();
    h.customerRetrieve.mockReset();
    h.customerCreate.mockReset();
    h.setupIntentCreate.mockReset();
    h.paymentMethodRetrieve.mockReset();
  });

  it('falls back to the pre-049 read shape during a dashboard-first rolling deploy', async () => {
    h.query
      .mockRejectedValueOnce(Object.assign(new Error('missing column'), { code: '42703' }))
      .mockResolvedValueOnce({ rows: [{
        enabled: true,
        stripe_payment_method_id: 'pm_123',
        threshold_microcents: '100000000',
        reload_amount_cents: '5000',
      }] });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disabled_reason: null, disabled_at: null });
    expect(h.query.mock.calls[1][0]).not.toContain('disabled_reason');
  });

  it('returns threshold cents using the shared microcent scale', async () => {
    h.query.mockResolvedValueOnce({
      rows: [{
        enabled: true,
        stripe_payment_method_id: 'pm_123',
        threshold_microcents: '100000000',
        reload_amount_cents: '5000',
        disabled_reason: 'topup_velocity_exceeded',
        disabled_at: '2026-07-14T00:00:00.000Z',
      }],
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.threshold_cents).toBe(100);
    expect(body.reload_amount_cents).toBe(5000);
    expect(body.disabled_reason).toBe('topup_velocity_exceeded');
    expect(body.disabled_at).toBe('2026-07-14T00:00:00.000Z');
  });

  it('stores threshold cents as microcents', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ stripe_payment_method_id: 'pm_123' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await POST(jsonReq('/api/credits/auto-topup', {
      threshold_cents: 500,
      reload_amount_cents: 2500,
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, enabled: true });
    const upsertCall = h.query.mock.calls[1];
    expect(upsertCall[1]).toEqual(['team_1', 500_000_000, 2500, true]);
    expect(upsertCall[0]).toContain('disabled_reason = CASE WHEN $4 THEN NULL');
    expect(upsertCall[0]).toContain('disabled_at = CASE WHEN $4 THEN NULL');
  });

  it('preserves the disabled reason while awaiting a payment method', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ stripe_payment_method_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_1' }] });
    h.customerRetrieve.mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: null } });
    h.setupIntentCreate.mockResolvedValue({ client_secret: 'seti_secret' });

    const res = await POST(jsonReq('/api/credits/auto-topup', {
      threshold_cents: 500,
      reload_amount_cents: 2500,
    }));

    expect(res.status).toBe(200);
    expect(h.query.mock.calls[1][0]).toContain(
      'disabled_reason = CASE WHEN $4 THEN NULL ELSE auto_topup_settings.disabled_reason END',
    );
    expect(h.query.mock.calls[1][1][3]).toBe(false);
  });

  it('enables a Stripe default payment method and clears disable state atomically', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ stripe_payment_method_id: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_1' }] })
      .mockResolvedValueOnce({ rows: [] });
    h.customerRetrieve.mockResolvedValue({
      deleted: false,
      invoice_settings: { default_payment_method: 'pm_default' },
    });

    const res = await POST(jsonReq('/api/credits/auto-topup', {
      threshold_cents: 500,
      reload_amount_cents: 2500,
    }));

    expect(res.status).toBe(200);
    const enableSql = h.query.mock.calls[3][0];
    expect(enableSql).toContain('enabled = true');
    expect(enableSql).toContain('disabled_reason = NULL');
    expect(enableSql).toContain('disabled_at = NULL');
  });

  it('disables and clears system-disable state atomically', async () => {
    h.query.mockResolvedValue({ rows: [] });

    const res = await DELETE();

    expect(res.status).toBe(200);
    expect(h.query.mock.calls[0][0]).toContain('enabled = false');
    expect(h.query.mock.calls[0][0]).toContain('disabled_reason = NULL');
    expect(h.query.mock.calls[0][0]).toContain('disabled_at = NULL');
  });

  it('confirm enables only a team-owned payment method and clears disable state atomically', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_1' }] })
      .mockResolvedValueOnce({ rows: [] });
    h.paymentMethodRetrieve.mockResolvedValue({ customer: 'cus_1' });

    const res = await CONFIRM(jsonReq('/api/credits/auto-topup/confirm', {
      payment_method_id: 'pm_owned',
    }));

    expect(res.status).toBe(200);
    const enableSql = h.query.mock.calls[1][0];
    expect(enableSql).toContain('enabled = true');
    expect(enableSql).toContain('disabled_reason = NULL');
    expect(enableSql).toContain('disabled_at = NULL');
  });

  it('confirm falls back to the pre-049 write shape during a dashboard-first rolling deploy', async () => {
    h.query
      .mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_1' }] })
      .mockRejectedValueOnce(Object.assign(new Error('missing column'), { code: '42703' }))
      .mockResolvedValueOnce({ rows: [] });
    h.paymentMethodRetrieve.mockResolvedValue({ customer: 'cus_1' });

    const res = await CONFIRM(jsonReq('/api/credits/auto-topup/confirm', {
      payment_method_id: 'pm_owned',
    }));

    expect(res.status).toBe(200);
    expect(h.query.mock.calls[2][0]).toContain('enabled = true');
    expect(h.query.mock.calls[2][0]).not.toContain('disabled_reason');
  });

  it('confirm rejects a payment method owned by another customer without mutating settings', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ stripe_customer_id: 'cus_1' }] });
    h.paymentMethodRetrieve.mockResolvedValue({ customer: 'cus_other' });

    const res = await CONFIRM(jsonReq('/api/credits/auto-topup/confirm', {
      payment_method_id: 'pm_other',
    }));

    expect(res.status).toBe(400);
    expect(h.query).toHaveBeenCalledOnce();
  });
});
