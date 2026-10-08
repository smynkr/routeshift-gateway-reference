import { expect, test, vi } from 'vitest';

vi.mock('@/lib/proxy', () => ({ PROXY_URL: 'http://proxy.internal:4000' }));

import { GET } from '@/app/api/public/catalog-stats/route';

test('returns cacheable live counts without exposing the private proxy URL', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      object: 'list',
      data: [
        { endpoints: [{ provider: 'openai' }] },
        { endpoints: [{ provider: 'anthropic' }] },
      ],
    }),
  }));

  const response = await GET();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ modelCount: 2, providerCount: 2 });
  expect(response.headers.get('cache-control')).toBe('public, s-maxage=3600');
  expect(JSON.stringify(body)).not.toContain('proxy.internal');
});

test('fails with one sanitized envelope when the runtime proxy is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED private-host')));
  const response = await GET();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'catalog_unavailable' });
});
