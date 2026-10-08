import { getPool } from '../db/pool.js';

export interface PlanLimits {
  maxKeys: number;
  maxRules: number;
  fallbacksEnabled: boolean;
  savingsSharePercent: number;
  creditsMarkupPercent: number;
}

// LAY-344 Option A (2026-04-29): single-tier model. BYOK/subscription mode
// has no provider-spend markup; active paid plans charge 3% of measured
// savings. Credits mode charges RouteShift-funded provider cost plus the
// plan's credits markup. Every user has full feature access from day 1.
// `free` = no active subscription, 0% savings-share/credits markup.
// `pro` = active subscription, 3% savings-share/credits markup.
//
// Legacy slugs (`starter`, `growth`, `enterprise`) are preserved as
// aliases of `pro` for any subscriptions.plan rows that pre-date this
// change. They're functionally identical.
const PLAN_LIMITS: Record<string, PlanLimits> = {
  free:       { maxKeys: Infinity, maxRules: Infinity, fallbacksEnabled: true, savingsSharePercent: 0, creditsMarkupPercent: 0 },
  pro:        { maxKeys: Infinity, maxRules: Infinity, fallbacksEnabled: true, savingsSharePercent: 3, creditsMarkupPercent: 3 },
  starter:    { maxKeys: Infinity, maxRules: Infinity, fallbacksEnabled: true, savingsSharePercent: 3, creditsMarkupPercent: 3 },
  growth:     { maxKeys: Infinity, maxRules: Infinity, fallbacksEnabled: true, savingsSharePercent: 3, creditsMarkupPercent: 3 },
  enterprise: { maxKeys: Infinity, maxRules: Infinity, fallbacksEnabled: true, savingsSharePercent: 3, creditsMarkupPercent: 3 },
};

const planCache = new Map<string, { plan: string; expires: number }>();
const PLAN_CACHE_TTL_MS = 60_000;
// billingMode flips only when an operator explicitly switches a team
// between credits and subscription — extremely rare. 5s would force ~20
// DB queries/team/sec at 100rps; 60s eliminates virtually all of them.
const BILLING_MODE_CACHE_TTL_MS = 60_000;

export async function getTeamPlan(teamId: string): Promise<string> {
  if (!process.env.DATABASE_URL) return 'free';

  const cached = planCache.get(teamId);
  if (cached && cached.expires > Date.now()) return cached.plan;

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT plan FROM subscriptions WHERE team_id = $1 AND status != 'canceled' LIMIT 1`,
    [teamId],
  );

  const plan = rows[0]?.plan ?? 'free';
  planCache.set(teamId, { plan, expires: Date.now() + PLAN_CACHE_TTL_MS });
  return plan;
}

export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

export async function checkLimit(
  teamId: string,
  resource: 'keys' | 'rules',
): Promise<{ allowed: boolean; current: number; limit: number }> {
  const plan = await getTeamPlan(teamId);
  const limits = getPlanLimits(plan);
  const pool = getPool();

  let current: number;
  let limit: number;

  if (resource === 'keys') {
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM api_keys WHERE team_id = $1 AND revoked_at IS NULL`,
      [teamId],
    );
    current = count;
    limit = limits.maxKeys;
  } else {
    const { rows: [{ count }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM routing_rules WHERE team_id = $1 AND enabled = true`,
      [teamId],
    );
    current = count;
    limit = limits.maxRules;
  }

  return { allowed: current < limit, current, limit };
}

export function invalidatePlanCache(teamId: string): void {
  planCache.delete(teamId);
}

const billingModeCache = new Map<string, { mode: 'subscription' | 'credits'; expires: number }>();

export async function getTeamBillingMode(teamId: string): Promise<'subscription' | 'credits'> {
  if (!process.env.DATABASE_URL) return 'subscription';
  const cached = billingModeCache.get(teamId);
  if (cached && cached.expires > Date.now()) return cached.mode;
  const pool = getPool();
  const { rows } = await pool.query('SELECT billing_mode FROM teams WHERE id = $1', [teamId]);
  const mode = (rows[0]?.billing_mode ?? 'subscription') as 'subscription' | 'credits';
  billingModeCache.set(teamId, { mode, expires: Date.now() + BILLING_MODE_CACHE_TTL_MS });
  return mode;
}

export function invalidateBillingModeCache(teamId: string): void {
  billingModeCache.delete(teamId);
}

// Periodic sweep of expired cache entries
const _planCacheSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of planCache) {
    if (entry.expires <= now) planCache.delete(key);
  }
  for (const [key, entry] of billingModeCache) {
    if (entry.expires <= now) billingModeCache.delete(key);
  }
}, 60_000);
_planCacheSweep.unref();
