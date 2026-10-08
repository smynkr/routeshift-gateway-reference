#!/usr/bin/env tsx
/**
 * Health-check the RouteShift demo/sample dataset. This is intentionally
 * read-only: it verifies DB rows and, when admin proxy credentials are present,
 * checks the admin usage endpoints that power cross-product demos.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @routeshift/dashboard demo:health
 *   PROXY_URL=http://localhost:4000 ADMIN_SECRET=... pnpm --filter @routeshift/dashboard demo:health -- --profile=small
 */
import pg from 'pg';
import { DEMO_TEAM_ID } from '../lib/demo-constants';
import { normalizeDemoSeedProfile, type DemoSeedProfile } from '../lib/demo-data';

const MICROCENTS_PER_USD = 100_000_000;

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface Thresholds {
  minUsers: number;
  minRequests: number;
  minSessions: number;
  minDistinctDays: number;
  minDistinctModels: number;
}

const THRESHOLDS: Record<DemoSeedProfile, Thresholds> = {
  small: { minUsers: 5, minRequests: 500, minSessions: 20, minDistinctDays: 7, minDistinctModels: 3 },
  standard: { minUsers: 25, minRequests: 10_000, minSessions: 500, minDistinctDays: 20, minDistinctModels: 5 },
  hero: { minUsers: 25, minRequests: 100_000, minSessions: 5_000, minDistinctDays: 20, minDistinctModels: 5 },
};

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const explicit = process.argv.find((arg) => arg.startsWith(prefix));
  if (explicit) return explicit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function currentMonthIso(): string {
  return new Date().toISOString().slice(0, 7);
}

function check(results: CheckResult[], name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

async function fetchJson(url: string, adminSecret: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${adminSecret}` },
  });
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: text };
  }
}

async function main(): Promise<void> {
  const profile = normalizeDemoSeedProfile(readArg('profile') ?? process.env.DEMO_SEED_PROFILE);
  const thresholds = THRESHOLDS[profile];
  const results: CheckResult[] = [];

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for demo data health checks');
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    const team = await pool.query<{ count: string }>('SELECT COUNT(*)::bigint AS count FROM teams WHERE id = $1', [DEMO_TEAM_ID]);
    const users = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::bigint AS count
       FROM team_members
       WHERE team_id = $1`,
      [DEMO_TEAM_ID],
    );
    const apiKeys = await pool.query<{ count: string }>('SELECT COUNT(*)::bigint AS count FROM api_keys WHERE team_id = $1', [DEMO_TEAM_ID]);
    const logs = await pool.query<{
      requests: string;
      sessions: string;
      distinct_days: string;
      distinct_models: string;
      savings_microcents: string | number | null;
      actual_microcents: string | number | null;
      cache_hits: string;
      errors: string;
    }>(
      `SELECT
         COUNT(*)::bigint AS requests,
         COUNT(DISTINCT session_id)::bigint AS sessions,
         COUNT(DISTINCT to_char(date_trunc('day', timestamp AT TIME ZONE 'UTC'), 'YYYY-MM-DD'))::bigint AS distinct_days,
         COUNT(DISTINCT model_resolved)::bigint AS distinct_models,
         COALESCE(SUM(savings_microcents), 0)::bigint AS savings_microcents,
         COALESCE(SUM(actual_cost_microcents), 0)::bigint AS actual_microcents,
         COUNT(*) FILTER (WHERE COALESCE(cache_hit, false))::bigint AS cache_hits,
         COUNT(*) FILTER (WHERE status_code >= 400)::bigint AS errors
       FROM request_logs
       WHERE team_id = $1`,
      [DEMO_TEAM_ID],
    );
    const optimize = await pool.query<{ count: string; savings_microcents: string | number | null }>(
      `SELECT COUNT(*)::bigint AS count,
              COALESCE(SUM(estimated_savings_microcents), 0)::bigint AS savings_microcents
       FROM optimize_findings
       WHERE team_id = $1 AND status = 'open'`,
      [DEMO_TEAM_ID],
    );
    const credits = await pool.query<{ count: string }>('SELECT COUNT(*)::bigint AS count FROM credit_balances WHERE team_id = $1', [DEMO_TEAM_ID]);
    const subscriptions = await pool.query<{ count: string }>('SELECT COUNT(*)::bigint AS count FROM subscriptions WHERE team_id = $1', [DEMO_TEAM_ID]);

    const logRow = logs.rows[0]!;
    const requests = Number(logRow.requests);
    const sessions = Number(logRow.sessions);
    const distinctDays = Number(logRow.distinct_days);
    const distinctModels = Number(logRow.distinct_models);
    const savings = Number(logRow.savings_microcents ?? 0);
    const actual = Number(logRow.actual_microcents ?? 0);
    const cacheHits = Number(logRow.cache_hits);
    const errors = Number(logRow.errors);

    check(results, 'demo team exists', Number(team.rows[0]?.count ?? 0) === 1, `team_id=${DEMO_TEAM_ID}`);
    check(results, 'demo users seeded', Number(users.rows[0]?.count ?? 0) >= thresholds.minUsers, `${users.rows[0]?.count ?? 0} users`);
    check(results, 'demo api keys seeded', Number(apiKeys.rows[0]?.count ?? 0) > 0, `${apiKeys.rows[0]?.count ?? 0} keys`);
    check(results, 'request logs seeded', requests >= thresholds.minRequests, `${requests.toLocaleString()} requests`);
    check(results, 'sessions seeded', sessions >= thresholds.minSessions, `${sessions.toLocaleString()} sessions`);
    check(results, 'multi-day coverage', distinctDays >= thresholds.minDistinctDays, `${distinctDays} distinct UTC days`);
    check(results, 'multi-model coverage', distinctModels >= thresholds.minDistinctModels, `${distinctModels} distinct resolved models`);
    check(results, 'positive actual spend', actual > 0, `$${(actual / MICROCENTS_PER_USD).toFixed(2)} actual`);
    check(results, 'positive savings', savings > 0, `$${(savings / MICROCENTS_PER_USD).toFixed(2)} savings`);
    check(results, 'cache-hit coverage', cacheHits > 0, `${cacheHits.toLocaleString()} cache hits`);
    check(results, 'error/rate-limit coverage', errors > 0, `${errors.toLocaleString()} error rows`);
    check(results, 'optimize findings seeded', Number(optimize.rows[0]?.count ?? 0) > 0, `${optimize.rows[0]?.count ?? 0} open findings`);
    check(results, 'credits seeded', Number(credits.rows[0]?.count ?? 0) > 0, `${credits.rows[0]?.count ?? 0} credit balance rows`);
    check(results, 'subscription seeded', Number(subscriptions.rows[0]?.count ?? 0) > 0, `${subscriptions.rows[0]?.count ?? 0} subscription rows`);
  } finally {
    await pool.end();
  }

  const proxyUrl = readArg('proxy-url') ?? process.env.PROXY_URL;
  const adminSecret = process.env.ADMIN_SECRET;
  if (proxyUrl && adminSecret) {
    const month = readArg('month') ?? currentMonthIso();
    const base = proxyUrl.replace(/\/$/, '');
    try {
      const savings = await fetchJson(`${base}/admin/usage/savings-series?team_id=${encodeURIComponent(DEMO_TEAM_ID)}&month=${month}`, adminSecret);
      const byModel = await fetchJson(`${base}/admin/usage/by-model-day?team_id=${encodeURIComponent(DEMO_TEAM_ID)}&month=${month}`, adminSecret);

      const savingsBody = savings.body as { series?: unknown[]; source?: string } | null;
      const byModelBody = byModel.body as { records?: unknown[]; source?: string } | null;
      check(results, 'proxy savings-series endpoint', savings.status === 200 && Array.isArray(savingsBody?.series) && savingsBody.series.length > 0, `HTTP ${savings.status}, ${savingsBody?.series?.length ?? 0} points for ${month}`);
      check(results, 'proxy by-model-day endpoint', byModel.status === 200 && Array.isArray(byModelBody?.records) && byModelBody.records.length > 0, `HTTP ${byModel.status}, ${byModelBody?.records?.length ?? 0} records for ${month}`);
      if (process.env.CLICKHOUSE_URL) {
        check(
          results,
          'ClickHouse demo posture',
          savingsBody?.source === 'postgres-demo' && byModelBody?.source === 'postgres-demo',
          `CLICKHOUSE_URL is configured; expected deployed demo endpoints to report source=postgres-demo, got savings=${savingsBody?.source ?? 'missing'} by_model=${byModelBody?.source ?? 'missing'}`,
        );
      }
    } catch (err) {
      check(
        results,
        'proxy endpoint checks failed',
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  } else {
    check(results, 'proxy endpoint checks skipped', true, 'set PROXY_URL and ADMIN_SECRET to verify deployed admin usage endpoints');
    if (process.env.CLICKHOUSE_URL) {
      check(
        results,
        'ClickHouse demo posture',
        false,
        'CLICKHOUSE_URL is configured, but RouteShift demo analytics are Postgres-only unless deployed demo endpoints report source=postgres-demo; set PROXY_URL and ADMIN_SECRET to verify the proxy posture',
      );
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`RouteShift demo data health (profile=${profile})`);
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
  }
  if (failed.length > 0) {
    console.error(`Demo data health failed: ${failed.length} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Demo data health check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
