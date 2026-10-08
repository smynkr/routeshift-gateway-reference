import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'owner' },
  query: vi.fn(),
  fetch: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('@/lib/rbac', () => ({ requireRole: async () => h.member }));
vi.mock('@/lib/demo', () => ({
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only',
  isDemoActive: async () => false,
}));
vi.mock('@/lib/proxy', () => ({
  PROXY_URL: 'https://proxy.test',
  adminHeaders: () => ({ Authorization: 'Bearer admin' }),
  assertAdminSecret: () => undefined,
}));
vi.mock('@/lib/crypto', () => ({ decryptProviderKey: (encrypted: string) => h.decrypt(encrypted) }));

import { PATCH } from '@/app/api/billing/mode/route';

describe('PATCH /api/billing/mode', () => {
  beforeEach(() => {
    h.query.mockReset();
    h.fetch.mockReset();
    h.decrypt.mockReset();
    h.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
  });

  it('requires an enabled, non-blank provider key before entering subscription mode', async () => {
    h.query.mockResolvedValueOnce({ rows: [] });

    const response = await PATCH(new Request('https://app.test/api/billing/mode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'subscription' }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'At least one usable provider key is required to switch to subscription mode' },
    });
    expect(String(h.query.mock.calls[0]?.[0])).toContain('enabled = true');
    expect(String(h.query.mock.calls[0]?.[0])).toContain("encrypted_key <> ''");
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('does not treat an encrypted whitespace-only legacy row as a usable key', async () => {
    const validV1 = 'AAAAAAAAAAAAAAAA:dGVzdA==:AAAAAAAAAAAAAAAAAAAAAA==';
    h.query.mockResolvedValueOnce({ rows: [{ encrypted_key: validV1, encryption_scheme: null }] });
    h.decrypt.mockResolvedValueOnce('   ');

    const response = await PATCH(new Request('https://app.test/api/billing/mode', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'subscription' }),
    }));

    expect(response.status).toBe(400);
    expect(h.decrypt).toHaveBeenCalledWith(validV1);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
