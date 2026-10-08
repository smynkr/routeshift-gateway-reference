// LAY-318: per-team model alias resolver.
//
// resolveAlias(teamId, model) returns the canonical name if the team has an
// alias for `model`, otherwise returns `model` unchanged. Result is cached
// per team for 60s; the admin /admin/model-aliases/invalidate endpoint busts
// the cache when the dashboard updates aliases.
//
// Aliases resolve only the *model* identity. Provider is still inferred
// from routing rules / provider keys after resolution.

import { getPool } from '../db/pool.js';

const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  aliases: Map<string, string>;
  expiresAt: number;
}

const teamCache = new Map<string, CacheEntry>();

async function loadAliases(teamId: string): Promise<Map<string, string>> {
  const pool = getPool();
  const { rows } = await pool.query<{ alias: string; canonical_name: string }>(
    `SELECT alias, canonical_name FROM model_aliases WHERE team_id = $1`,
    [teamId],
  );
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.alias, r.canonical_name);
  return map;
}

export async function resolveAlias(teamId: string, model: string): Promise<string> {
  const cached = teamCache.get(teamId);
  let aliases: Map<string, string>;
  if (cached && cached.expiresAt > Date.now()) {
    aliases = cached.aliases;
  } else {
    aliases = await loadAliases(teamId);
    teamCache.set(teamId, { aliases, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return aliases.get(model) ?? model;
}

export function invalidateAliasCache(teamId?: string): void {
  if (teamId) teamCache.delete(teamId);
  else teamCache.clear();
}
