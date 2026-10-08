import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  getDbPricing,
  __pricingCacheSize,
  __resetPricingCache,
  __PRICING_CACHE_MAX_ENTRIES,
} from '../src/cost/pricing-db.js';

describe('getDbPricing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetPricingCache();
  });

  it('caches a positive hit and serves the second call without re-querying', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ provider: 'openai', model: 'gpt-4.1', input_price: '3', output_price: '6' }],
    });
    const a = await getDbPricing('openai', 'gpt-4.1');
    const b = await getDbPricing('openai', 'gpt-4.1');
    expect(a).toEqual({ provider: 'openai', model: 'gpt-4.1', input_per_million: 3, output_per_million: 6 });
    expect(b).toEqual(a);
    expect(mockQuery).toHaveBeenCalledTimes(1); // 2nd served from cache
  });

  it('negatively caches a miss so an unpriced model does not re-query within the TTL', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await getDbPricing('openai', 'nope')).toBeNull();
    expect(await getDbPricing('openai', 'nope')).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('stays bounded under a flood of distinct unpriced models (negative cache cannot grow unbounded)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    for (let i = 0; i < __PRICING_CACHE_MAX_ENTRIES + 200; i++) {
      await getDbPricing('openai', `bogus-${i}`);
    }
    expect(__pricingCacheSize()).toBeLessThanOrEqual(__PRICING_CACHE_MAX_ENTRIES);
  });
});
