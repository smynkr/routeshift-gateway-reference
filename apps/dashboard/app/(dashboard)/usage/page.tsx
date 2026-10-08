import { ModelBreakdownChart } from '@/components/charts/model-breakdown-chart';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';
import { categoryColor, categoryLabel } from '@/lib/activity-categories';
import { Activity, Hash, Clock, Layers } from 'lucide-react';
import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const MICROCENTS_TO_USD = 100_000_000;

export const metadata = { title: 'Usage' };
export const dynamic = 'force-dynamic';

async function getUsageData() {
  try {
    const member = await requireTeamMembership();
    if (!member) return { data: null, error: null };
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return { data: null, error: 'No team context is available for this session.' };

    const hours = 168; // 7 days

    const pool = getPool();

    // Summary metrics
    const summaryResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_requests,
         COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
         COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
         COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_latency_ms), 0)::int AS p95_latency_ms,
         COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY total_latency_ms), 0)::int AS p99_latency_ms,
         COUNT(DISTINCT model_resolved)::int AS models_used,
         COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - make_interval(hours => $2)`,
      [teamId, hours],
    );

    const s = summaryResult.rows[0];

    // Per-model breakdown
    const modelResult = await pool.query(
      `SELECT
         model_resolved AS model,
         COUNT(*)::int AS requests,
         COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
         COALESCE(SUM(total_tokens), 0)::bigint AS tokens
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - make_interval(hours => $2)
       GROUP BY model_resolved
       ORDER BY requests DESC`,
      [teamId, hours],
    );

    const model_breakdown = modelResult.rows.map((row) => ({
      model: row.model,
      requests: row.requests,
      avg_latency_ms: row.avg_latency_ms,
      tokens: Number(row.tokens),
    }));

    // Per-category breakdown — relies on activity_category column added in
    // migration 015. Rows logged before 015 have NULL and render as
    // "Uncategorized".
    const categoryResult = await pool.query(
      `SELECT
         activity_category AS category,
         COUNT(*)::int AS requests,
         COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
         COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_spend_microcents
         , COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - make_interval(hours => $2)
       GROUP BY activity_category
       ORDER BY requests DESC`,
      [teamId, hours],
    );

    const category_breakdown = categoryResult.rows.map((row) => ({
      category: row.category as string | null,
      requests: row.requests,
      tokens: Number(row.tokens),
      billed_spend_usd: Number(row.billed_spend_microcents) / MICROCENTS_TO_USD,
      unknown_cost_requests: Number(row.unknown_cost_requests ?? 0),
      actual_costs_qualified: Number(row.unknown_cost_requests ?? 0) === 0,
    }));

    return {
      data: {
        summary: {
          total_requests: s.total_requests,
          total_tokens: Number(s.total_tokens),
          avg_latency_ms: s.avg_latency_ms,
          p95_latency_ms: s.p95_latency_ms,
          p99_latency_ms: s.p99_latency_ms,
          models_used: s.models_used,
          unknown_cost_requests: Number(s.unknown_cost_requests ?? 0),
          actual_costs_qualified: Number(s.unknown_cost_requests ?? 0) === 0,
        },
        model_breakdown,
        category_breakdown,
      },
      error: null,
    };
  } catch (err) {
    console.error('Usage metrics error:', err);
    return {
      data: null,
      error: 'Unable to load usage metrics. Check the dashboard database connection and try again.',
    };
  }
}

export default async function UsagePage() {
  const result = await getUsageData();
  const data = result.data;
  const s = data?.summary;
  const isEmpty = !result.error && (!data || s?.total_requests === 0);

  const kpis = [
    { title: 'Total Requests', value: s ? s.total_requests.toLocaleString() : '---', Icon: Activity },
    { title: 'Total Tokens', value: s ? s.total_tokens.toLocaleString() : '---', Icon: Hash },
    { title: 'Avg Latency', value: s ? `${s.avg_latency_ms}ms` : '---', Icon: Clock },
    { title: 'Models Used', value: s ? String(s.models_used) : '---', Icon: Layers },
  ];

  const maxLatency = s ? (s.p99_latency_ms || s.avg_latency_ms || 1) : 1;

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white">Usage Analytics</h2>
        <p className="mt-1 text-neutral-400">Token usage, model distribution, and latency metrics.</p>
      </div>

      {result.error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4 text-sm text-red-200">
          {result.error}
        </div>
      ) : isEmpty ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <div className="flex justify-center mb-4">
            <Activity className="h-10 w-10 text-neutral-600" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No usage yet</h3>
          <p className="text-sm text-neutral-500 max-w-md mx-auto mb-6">
            Send your first request through RouteShift to see token, model, and latency breakdowns.
          </p>
          <Link
            href="/settings"
            className="text-sm font-medium text-emerald-400 transition-colors hover:text-emerald-300"
          >
            View setup guide &rarr;
          </Link>
        </div>
      ) : (
        <>
      {s && <CostQualificationNotice unknownCostRequests={s.unknown_cost_requests} />}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => (
          <div
            key={kpi.title}
            className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-5 transition-all duration-300 hover:border-white/[0.1]"
          >
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-neutral-500">{kpi.title}</p>
              <kpi.Icon className="h-4 w-4 text-neutral-600" />
            </div>
            <div className="mt-2 text-2xl font-bold text-white">{kpi.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-4 text-lg font-semibold text-white">Requests by Model</h3>
          <ModelBreakdownChart data={data?.model_breakdown ?? []} />
        </div>

        <div>
          <h3 className="mb-4 text-lg font-semibold text-white">Latency Percentiles</h3>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
            {s ? (
              <div className="space-y-5">
                {[
                  { label: 'Average', value: `${s.avg_latency_ms}ms`, width: (s.avg_latency_ms / maxLatency) * 100, color: 'bg-emerald-500' },
                  { label: 'P95', value: `${s.p95_latency_ms}ms`, width: (s.p95_latency_ms / maxLatency) * 100, color: 'bg-teal-500' },
                  { label: 'P99', value: `${s.p99_latency_ms}ms`, width: (s.p99_latency_ms / maxLatency) * 100, color: 'bg-cyan-500' },
                ].map((stat) => (
                  <div key={stat.label}>
                    <div className="mb-2 flex justify-between text-sm">
                      <span className="text-neutral-400">{stat.label}</span>
                      <span className="font-medium text-white">{stat.value}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                      <div
                        className={`h-full rounded-full ${stat.color} transition-all duration-700`}
                        style={{ width: `${stat.width}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-neutral-500">No latency data yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* Activity Category Breakdown */}
      {data?.category_breakdown && data.category_breakdown.length > 0 && (
        <div>
          <h3 className="mb-4 text-lg font-semibold text-white">Requests &amp; billed spend by activity</h3>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
            <CategoryStackedBar rows={data.category_breakdown} />
          </div>
        </div>
      )}

      {/* Model Details Table */}
      {data?.model_breakdown && data.model_breakdown.length > 0 && (
        <div>
          <h3 className="mb-4 text-lg font-semibold text-white">Model Details</h3>
          <div className="overflow-hidden rounded-xl border border-white/[0.06]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Avg Latency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.model_breakdown.map((m: any) => (
                  <TableRow key={m.model}>
                    <TableCell className="font-mono text-neutral-300">{m.model}</TableCell>
                    <TableCell className="text-right text-neutral-400">{m.requests.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-neutral-400">{m.tokens.toLocaleString()}</TableCell>
                    <TableCell className="text-right text-neutral-400">{m.avg_latency_ms}ms</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}

function CategoryStackedBar({
  rows,
}: {
  rows: Array<{ category: string | null; requests: number; tokens: number; billed_spend_usd: number }>;
}) {
  const total = rows.reduce((sum, r) => sum + r.requests, 0);
  if (total === 0) {
    return <p className="py-8 text-center text-neutral-500">No categorized traffic yet.</p>;
  }
  return (
    <div className="space-y-5">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/[0.04]">
        {rows.map((row) => {
          const pct = (row.requests / total) * 100;
          return (
            <div
              key={row.category ?? 'null'}
              className={`${categoryColor(row.category)} h-full transition-all duration-700`}
              style={{ width: `${pct}%` }}
              title={`${categoryLabel(row.category)}: ${row.requests.toLocaleString()} requests`}
            />
          );
        })}
      </div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm md:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => {
          const pct = Math.round((row.requests / total) * 100);
          return (
            <div key={row.category ?? 'null'} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-neutral-300">
                <span className={`inline-block h-2 w-2 rounded-full ${categoryColor(row.category)}`} />
                {categoryLabel(row.category)}
              </span>
              <span className="font-mono text-xs text-neutral-500">
                {row.requests.toLocaleString()} · {pct}% · ${row.billed_spend_usd.toFixed(2)} billed
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
