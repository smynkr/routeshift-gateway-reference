import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' },
  query: vi.fn(),
  encrypt: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({ requireRole: async () => h.member }));
vi.mock('@/lib/demo', () => ({
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only',
  isDemoActive: async () => false,
}));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('@/lib/crypto', () => ({ encryptProviderKey: (key: string) => h.encrypt(key) }));
vi.mock('@/lib/proxy', () => ({
  PROXY_URL: 'https://proxy.test',
  adminHeaders: () => ({ Authorization: 'Bearer admin' }),
}));

import { POST, PUT } from '@/app/api/provider-keys/[provider]/route';
import { POST as testProviderKey } from '@/app/api/provider-keys/[provider]/test/route';
import { PATCH } from '@/app/api/provider-keys/[provider]/[label]/route';

const validV1 = 'AwMDAwMDAwMDAwMD:cm90YXRlZA==:BAQEBAQEBAQEBAQEBAQEvg==';
const validV2 = 'v2:arn:aws:kms:us-east-1:123456789012:key/abc:d3JhcHBlZA==:AQEBAQEBAQEBAQEB:Y2lwaGVydGV4dA==:AgICAgICAgICAgICAgICAg==';
const validV3 = JSON.stringify({
  v: 3,
  alg: 'A256GCM',
  iv: 'AQEBAQEBAQEBAQEB',
  ciphertext: 'Y2lwaGVydGV4dA',
  tag: 'AgICAgICAgICAgICAgICAg',
});

function jsonRequest(method: string, body: unknown): Request {
  return new Request('https://app.test/api/provider-keys/openai', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('provider-key input validation', () => {
  beforeEach(() => {
    h.query.mockReset();
    h.encrypt.mockReset();
    h.fetch.mockReset();
    vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
  });

  it.each([
    ['PUT', (request: Request) => PUT(request, { params: Promise.resolve({ provider: 'openai' }) }), { key: '   ' }],
    ['POST', (request: Request) => POST(request, { params: Promise.resolve({ provider: 'openai' }) }), { label: 'primary', key: '\t\n' }],
    ['PATCH', (request: Request) => PATCH(request, { params: Promise.resolve({ provider: 'openai', label: 'primary' }) }), { key: '  ' }],
  ])('rejects whitespace-only credentials on %s', async (method, handler, body) => {
    const response = await handler(jsonRequest(method, body));

    expect(response.status).toBe(400);
    expect(h.encrypt).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('trims harmless surrounding whitespace before encrypting a provider key', async () => {
    h.encrypt.mockResolvedValue('AAAAAAAAAAAAAAAA:dGVzdA==:AAAAAAAAAAAAAAAAAAAAAA==');
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await PUT(
      jsonRequest('PUT', { key: '  sk-provider-key  ' }),
      { params: Promise.resolve({ provider: 'openai' }) },
    );

    expect(response.status).toBe(200);
    expect(h.encrypt).toHaveBeenCalledWith('sk-provider-key');
  });

  it('requires a per-key Cloudflare account ID when saving a Cloudflare key', async () => {
    const response = await PUT(
      jsonRequest('PUT', { key: 'cloudflare-key' }),
      { params: Promise.resolve({ provider: 'cloudflare-workers-ai' }) },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('metadata.account_id') },
    });
    expect(h.encrypt).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('persists the Cloudflare account ID as non-secret provider metadata', async () => {
    h.encrypt.mockResolvedValue(validV1);
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await PUT(
      jsonRequest('PUT', {
        key: 'cloudflare-key',
        metadata: { account_id: '0123456789abcdef0123456789abcdef' },
      }),
      { params: Promise.resolve({ provider: 'cloudflare-workers-ai' }) },
    );

    expect(response.status).toBe(200);
    const [, values] = h.query.mock.calls[0];
    expect(values[2]).toBe('cloudflare-workers-ai');
    expect(values[4]).toEqual({ account_id: '0123456789abcdef0123456789abcdef' });
  });
  it('tests a Cloudflare BYOK key against its supplied account ID', async () => {
    h.fetch.mockResolvedValue(new Response(null, { status: 200 }));

    const response = await testProviderKey(
      new Request('https://app.test/api/provider-keys/cloudflare-workers-ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'cloudflare-key',
          metadata: { account_id: 'abcdef0123456789abcdef0123456789' },
        }),
      }),
      { params: Promise.resolve({ provider: 'cloudflare-workers-ai' }) },
    );

    expect(response.status).toBe(200);
    const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/abcdef0123456789abcdef0123456789/ai/v1/chat/completions',
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: '@cf/zai-org/glm-5.3-flash',
      max_tokens: 1,
    });
  });


  it('clears a stale team DEK version when PUT rotates the default key', async () => {
    h.encrypt.mockResolvedValue(validV1);
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await PUT(
      jsonRequest('PUT', { key: 'sk-rotated' }),
      { params: Promise.resolve({ provider: 'openai' }) },
    );

    expect(response.status).toBe(200);
    const [sql] = h.query.mock.calls[0];
    const normalizedSql = String(sql).replace(/\s+/g, ' ');
    expect(normalizedSql).toContain('encryption_scheme, encryption_key_version)');
    expect(normalizedSql).toContain("true, $6, NULL)");
    expect(normalizedSql).toContain('encryption_key_version = NULL');
  });

  it('clears a stale team DEK version when PATCH rotates a labeled key', async () => {
    h.encrypt.mockResolvedValue(validV2);
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await PATCH(
      new Request('https://app.test/api/provider-keys/openai/primary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'sk-rotated' }),
      }),
      { params: Promise.resolve({ provider: 'openai', label: 'primary' }) },
    );

    expect(response.status).toBe(200);
    const [sql, values] = h.query.mock.calls[0];
    expect(String(sql)).toContain('encryption_key_version = $3');
    expect(values[2]).toBeNull();
  });

  it('binds the cleared version correctly in a compound labeled-key PATCH', async () => {
    h.encrypt.mockResolvedValue(validV2);
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await PATCH(
      new Request('https://app.test/api/provider-keys/openai/primary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          weight: 2,
          enabled: false,
          key: 'sk-rotated',
          metadata: {},
        }),
      }),
      { params: Promise.resolve({ provider: 'openai', label: 'primary' }) },
    );

    expect(response.status).toBe(200);
    const [sql, values] = h.query.mock.calls[0];
    expect(String(sql)).toContain('encryption_key_version = $5');
    expect(values.slice(0, 6)).toEqual([
      2,
      false,
      validV2,
      'kms-per-write-v2',
      null,
      {},
    ]);
  });

  it('uses an explicit NULL DEK version for a fresh labeled-key insert', async () => {
    h.encrypt.mockResolvedValue(validV1);
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await POST(
      jsonRequest('POST', { label: 'primary', key: 'sk-provider-key' }),
      { params: Promise.resolve({ provider: 'openai' }) },
    );

    expect(response.status).toBe(200);
    const [sql] = h.query.mock.calls[0];
    const normalizedSql = String(sql).replace(/\s+/g, ' ');
    expect(normalizedSql).toContain('encryption_scheme, encryption_key_version)');
    expect(normalizedSql).toContain('$8, $9, NULL)');
  });

  it('preserves the team DEK version when PATCH changes only non-key fields', async () => {
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.fetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await PATCH(
      new Request('https://app.test/api/provider-keys/openai/primary', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weight: 2, enabled: false, metadata: {} }),
      }),
      { params: Promise.resolve({ provider: 'openai', label: 'primary' }) },
    );

    expect(response.status).toBe(200);
    const [sql] = h.query.mock.calls[0];
    expect(String(sql)).not.toContain('encryption_key_version');
    expect(h.encrypt).not.toHaveBeenCalled();
  });

  it.each([
    [
      'PUT',
      (request: Request) => PUT(request, { params: Promise.resolve({ provider: 'openai' }) }),
      { key: 'sk-provider-key' },
    ],
    [
      'POST',
      (request: Request) => POST(request, { params: Promise.resolve({ provider: 'openai' }) }),
      { label: 'primary', key: 'sk-provider-key' },
    ],
    [
      'PATCH',
      (request: Request) => PATCH(request, {
        params: Promise.resolve({ provider: 'openai', label: 'primary' }),
      }),
      { key: 'sk-provider-key' },
    ],
  ])('rejects a V3 envelope from the versionless %s writer', async (method, handler, body) => {
    h.encrypt.mockResolvedValue(validV3);

    const response = await handler(jsonRequest(method, body));

    expect(response.status).toBe(500);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
