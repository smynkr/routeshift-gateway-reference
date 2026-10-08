import { describe, expect, it, vi } from 'vitest';
import { fetchLandingCatalogStats, isLandingCatalogStats, parseLandingCatalog } from '@/lib/landing-catalog';

describe('parseLandingCatalog', () => {
  it('counts models and unique endpoint providers from a valid models response', () => {
    expect(parseLandingCatalog({
      object: 'list',
      data: [
        { endpoints: [{ provider: 'openai' }, { provider: 'anthropic' }] },
        { endpoints: [{ provider: 'openai' }] },
      ],
    })).toEqual({ modelCount: 2, providerCount: 2 });
  });

  it.each([
    null,
    {},
    { object: 'model', data: [] },
    { object: 'list', data: [] },
    { object: 'list', data: [{ endpoints: 'not-an-array' }] },
    { object: 'list', data: [{ endpoints: [{ provider: 42 }] }] },
  ])('rejects malformed or empty catalog payloads: %j', (value) => {
    expect(parseLandingCatalog(value)).toBeNull();
  });
});

describe('isLandingCatalogStats', () => {
  it('accepts only finite non-negative integer counts', () => {
    expect(isLandingCatalogStats({ modelCount: 2, providerCount: 1 })).toBe(true);
    expect(isLandingCatalogStats({ modelCount: 0, providerCount: 0 })).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { modelCount: '2', providerCount: 1 },
    { modelCount: 2.5, providerCount: 1 },
    { modelCount: 2, providerCount: -1 },
    { modelCount: Number.NaN, providerCount: 1 },
    { modelCount: 2, providerCount: Number.POSITIVE_INFINITY },
  ])('rejects malformed stats payloads: %j', (value) => {
    expect(isLandingCatalogStats(value)).toBe(false);
  });
});

describe('fetchLandingCatalogStats', () => {
  it('fetches and parses a catalog from an explicit runtime base URL', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        object: 'list',
        data: [{ endpoints: [{ provider: 'openai' }, { provider: 'azure' }] }],
      }),
    });

    await expect(fetchLandingCatalogStats('http://proxy.railway.internal:4000', fetcher as typeof fetch))
      .resolves.toEqual({ modelCount: 1, providerCount: 2 });
    expect(fetcher).toHaveBeenCalledWith(
      'http://proxy.railway.internal:4000/v1/models',
      expect.objectContaining({ headers: { Accept: 'application/json' }, cache: 'no-store' }),
    );
  });

  it('returns null for non-OK or malformed responses', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, json: vi.fn() });
    await expect(fetchLandingCatalogStats('http://proxy.internal:4000', fetcher as typeof fetch)).resolves.toBeNull();

    const malformed = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ object: 'list', data: [] }) });
    await expect(fetchLandingCatalogStats('http://proxy.internal:4000', malformed as typeof fetch)).resolves.toBeNull();
  });
});
