// LAY-348: cached lookup for `teams.tpm_limit`. The proxy hits this on
// every request after auth, so the cache makes it free in steady state.
// Cache invalidation is by TTL; the settings UI mutates infrequently and
// the 60s window is tight enough that an admin who lowers the cap waits
// at most a minute for it to take effect.

import { getPool } from '../db/pool.js';

interface CacheEntry {
  limit: number | null;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

export async function getTeamTpmLimit(teamId: string): Promise<number | null> {
  if (!process.env.DATABASE_URL) return null;

  const cached = cache.get(teamId);
  if (cached && cached.expires > Date.now()) return cached.limit;

  const pool = getPool();
  const { rows } = await pool.query<{ tpm_limit: number | null }>(
    `SELECT tpm_limit FROM teams WHERE id = $1`,
    [teamId],
  );

  const limit = rows[0]?.tpm_limit ?? null;
  cache.set(teamId, { limit, expires: Date.now() + TTL_MS });
  return limit;
}

export function invalidateTeamTpmLimit(teamId: string): void {
  cache.delete(teamId);
}
