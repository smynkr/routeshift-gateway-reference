import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import {
  DEFAULT_PLUGINS_PERIOD,
  PERIOD_HOURS,
  PLUGIN_IDS,
  isPluginsUsagePeriod,
  type PluginRecentWarning,
  type PluginRunStatus,
  type PluginUsageByPlugin,
  type PluginsUsageEnvelope,
  type PluginsUsagePeriod,
} from '@/lib/plugins';
import { requireTeamMembership } from '@/lib/rbac';

// pg wire types: ::int counts arrive as numbers, ::bigint costs arrive as
// strings (int8 exceeds JS safe-integer range in the general case, so node-pg
// keeps them as text). Number() normalizes both to integers before they leave
// the route — exact up to Number.MAX_SAFE_INTEGER (2^53-1 microcents ≈ $90M
// per team per period, unreachable at $0.005/search scale); the client's
// Number.isSafeInteger guard fail-closes anything past that bound.
interface SummaryRow {
  total_runs: number;
  requests_with_plugins: number;
  total_plugin_cost_microcents: string | number;
}

interface ByPluginRow {
  plugin_id: string;
  runs: number;
  ok: number;
  warning: number;
  error: number;
  skipped: number;
  cost_microcents: string | number;
}

interface WarningRow {
  plugin_id: string;
  status: Exclude<PluginRunStatus, 'ok'>;
  detail: string | null;
  cost_microcents: string | number;
  latency_ms: number;
  created_at: Date;
}

// Team-scoped private read: no intermediary may ever serve team A's envelope
// to team B from a shared cache.
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
    }
    // The rbac gate above returns null unless the session carries a truthy
    // teamId, so the effective id is always present past this point.
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;

    const { searchParams } = new URL(request.url);
    // Poison-guard: the raw period string never reaches SQL or the response —
    // it is whitelist-mapped here, and Postgres only ever sees the mapped
    // hours value as a bound parameter.
    const rawPeriod = searchParams.get('period') ?? DEFAULT_PLUGINS_PERIOD;
    const period: PluginsUsagePeriod = isPluginsUsagePeriod(rawPeriod) ? rawPeriod : DEFAULT_PLUGINS_PERIOD;
    const hours = PERIOD_HOURS[period];

    const pool = getPool();
    // Shared window lower bound for both windowed queries: without it, each
    // statement evaluated NOW() independently at transaction start, widening
    // the skew window from statement-gap to transaction-gap. This does NOT
    // make the two reads one snapshot — they are still separate statements on
    // separate connections, so a row committed between them lands in the
    // breakdown but not the totals until the next refresh (cosmetic only; a
    // strict in-envelope reconcile guard would false-positive on it).
    const asOf = new Date();
    const [summaryResult, byPluginResult, warningsResult] = await Promise.all([
      pool.query<SummaryRow>(
        `SELECT
           COUNT(*)::int AS total_runs,
           COUNT(DISTINCT request_id)::int AS requests_with_plugins,
           COALESCE(SUM(cost_microcents), 0)::bigint AS total_plugin_cost_microcents
         FROM plugin_runs
         WHERE team_id = $1
           AND created_at >= $3::timestamptz - make_interval(hours => $2)`,
        [teamId, hours, asOf],
      ),
      pool.query<ByPluginRow>(
        `SELECT
           plugin_id,
           COUNT(*)::int AS runs,
           COUNT(*) FILTER (WHERE status = 'ok')::int AS ok,
           COUNT(*) FILTER (WHERE status = 'warning')::int AS warning,
           COUNT(*) FILTER (WHERE status = 'error')::int AS error,
           COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
           COALESCE(SUM(cost_microcents), 0)::bigint AS cost_microcents
         FROM plugin_runs
         WHERE team_id = $1
           AND created_at >= $3::timestamptz - make_interval(hours => $2)
         GROUP BY plugin_id
         ORDER BY plugin_id`,
        [teamId, hours, asOf],
      ),
      // All-time by design (see PluginRecentWarning in lib/plugins): triage
      // wants the latest failures regardless of the totals lookback. Hardcoded
      // LIMIT: no client-controlled pagination on the warnings feed.
      pool.query<WarningRow>(
        `SELECT
           plugin_id,
           status,
           detail,
           cost_microcents,
           latency_ms,
           created_at
         FROM plugin_runs
         WHERE team_id = $1
           AND status <> 'ok'
         ORDER BY created_at DESC
         LIMIT 20`,
        [teamId],
      ),
    ]);

    // Aggregate without GROUP BY always returns exactly one row.
    const summaryRow = summaryResult.rows[0];
    const byPluginRows = new Map(byPluginResult.rows.map((row) => [row.plugin_id, row]));

    const toByPlugin = (pluginId: string): PluginUsageByPlugin => {
      const row = byPluginRows.get(pluginId);
      return {
        plugin_id: pluginId,
        runs: Number(row?.runs ?? 0),
        ok: Number(row?.ok ?? 0),
        warning: Number(row?.warning ?? 0),
        error: Number(row?.error ?? 0),
        skipped: Number(row?.skipped ?? 0),
        cost_microcents: Number(row?.cost_microcents ?? 0),
      };
    };

    const envelope: PluginsUsageEnvelope = {
      period,
      summary: {
        total_plugin_cost_microcents: Number(summaryRow.total_plugin_cost_microcents),
        total_runs: Number(summaryRow.total_runs),
        requests_with_plugins: Number(summaryRow.requests_with_plugins),
        by_plugin: [
          ...PLUGIN_IDS.map(toByPlugin),
          ...byPluginResult.rows
            .filter((row) => !(PLUGIN_IDS as readonly string[]).includes(row.plugin_id))
            .map((row) => toByPlugin(row.plugin_id)),
        ],
      },
      recent_warnings: warningsResult.rows.map((row): PluginRecentWarning => ({
        plugin_id: row.plugin_id,
        status: row.status,
        detail: row.detail,
        cost_microcents: Number(row.cost_microcents),
        latency_ms: Number(row.latency_ms),
        created_at: row.created_at.toISOString(),
      })),
    };

    return NextResponse.json(envelope, { headers: NO_STORE });
  } catch (err) {
    console.error('Plugin usage error:', err);
    return NextResponse.json(
      { error: 'Failed to load plugin usage' },
      { status: 500, headers: NO_STORE },
    );
  }
}
