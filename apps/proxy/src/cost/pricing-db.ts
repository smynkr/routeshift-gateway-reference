// apps/proxy/src/cost/pricing-db.ts
import { getPool } from '../db/pool.js';
import type { ModelPricing } from '@routeshift/shared';

const cache = new Map<string, { pricing: ModelPricing | null; expires: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 1 min — cache "no pricing row" misses briefly
// Bound the cache: the key is `${provider}:${model}` and `model` can be a
// request-derived alias, so both positive and negative entries are kept under a
// hard cap by evicting the oldest-inserted at capacity (Map preserves insertion
// order), mirroring cache/response-cache.ts. Stale entries are otherwise never
// swept, so without this the Map only grows.
const MAX_ENTRIES = 10_000;

function setCache(key: string, value: { pricing: ModelPricing | null; expires: number }): void {
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, value);
}

export async function getDbPricing(provider: string, model: string): Promise<ModelPricing | null> {
  const key = `${provider}:${model}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.pricing;

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT provider, model, input_price, output_price
       FROM pricing_entries
       WHERE provider = $1 AND model = $2
         AND effective_from <= now()
         AND (effective_until IS NULL OR effective_until > now())
       ORDER BY effective_from DESC LIMIT 1`,
      [provider, model],
    );

    if (rows.length === 0) {
      // Cache the miss (short TTL) so an unpriced model doesn't hit the DB on
      // every request; the short TTL still lets a newly-added price appear soon.
      setCache(key, { pricing: null, expires: Date.now() + NEGATIVE_CACHE_TTL_MS });
      return null;
    }

    const row = rows[0];
    const pricing: ModelPricing = {
      provider: row.provider,
      model: row.model,
      input_per_million: parseFloat(row.input_price),
      output_per_million: parseFloat(row.output_price),
    };

    setCache(key, { pricing, expires: Date.now() + CACHE_TTL_MS });
    return pricing;
  } catch (err) {
    console.error('Pricing DB lookup failed:', err);
    return null; // DB not available, caller falls back to static
  }
}

/** Test-only: hard cap on cache entries (positive + negative). */
export const __PRICING_CACHE_MAX_ENTRIES = MAX_ENTRIES;

/** Test-only: current cache size, to assert the bound holds. */
export function __pricingCacheSize(): number {
  return cache.size;
}

/** Test-only: reset the module cache between cases. */
export function __resetPricingCache(): void {
  cache.clear();
}
