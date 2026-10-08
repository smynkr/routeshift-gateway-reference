// apps/proxy/src/routing/rule-cache.ts
import { getPool } from '../db/pool.js';
import type { RoutingRule } from '@routeshift/shared';
import { getTeamPlan, getPlanLimits } from '../billing/plan-limits.js';

const cachedRulesMap = new Map<string, RoutingRule[]>();
let cacheExpires = 0;
const CACHE_TTL_MS = 60_000;

export async function getRulesForTeam(teamId: string): Promise<RoutingRule[]> {
  await refreshCacheIfNeeded();
  const teamSpecific = cachedRulesMap.get(teamId) ?? [];
  const wildcardRules = cachedRulesMap.get('*') ?? [];
  const teamRules = [...teamSpecific, ...wildcardRules].sort((a, b) => a.priority - b.priority);

  const plan = await getTeamPlan(teamId);
  const limits = getPlanLimits(plan);
  if (limits.maxRules !== Infinity && teamRules.length > limits.maxRules) {
    return teamRules.slice(0, limits.maxRules);
  }

  return teamRules;
}

let refreshPromise: Promise<void> | null = null;

async function refreshCacheIfNeeded(): Promise<void> {
  if (Date.now() < cacheExpires) return;
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function doRefresh(): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, team_id, name, priority, enabled, condition, action
     FROM routing_rules WHERE enabled = true
     ORDER BY priority ASC`,
  );

  cachedRulesMap.clear();
  for (const row of rows) {
    const rule: RoutingRule = {
      id: row.id,
      team_id: row.team_id,
      name: row.name,
      priority: row.priority,
      enabled: row.enabled,
      condition: row.condition,
      action: row.action,
    };
    const key = rule.team_id;
    const bucket = cachedRulesMap.get(key);
    if (bucket) bucket.push(rule);
    else cachedRulesMap.set(key, [rule]);
  }

  cacheExpires = Date.now() + CACHE_TTL_MS;
}

export function invalidateRuleCache(): void {
  cacheExpires = 0;
}
