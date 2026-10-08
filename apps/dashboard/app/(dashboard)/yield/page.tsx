import { KpiCard } from '@/components/stats/kpi-card';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';
import { Target } from 'lucide-react';
import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const metadata = { title: 'Yield' };
export const dynamic = 'force-dynamic';

const MICROCENTS_TO_USD = 100_000_000;

interface YieldRow {
  session_id: string;
  label: 'productive' | 'reverted' | 'abandoned';
  matched_commit_sha: string | null;
  matched_commit_repo: string | null;
  matched_commit_at: string | null;
  session_ended_at: string;
  primary_model: string | null;
  billed_cost_microcents: string;
  unknown_cost_requests: number;
}

async function getYieldData() {
  try {
    const member = await requireTeamMembership();
    if (!member) return { data: null, error: null };
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return { data: null, error: 'No team context is available for this session.' };

    const pool = getPool();

    // 30-day summary by label.
    const summary = await pool.query<{
      label: 'productive' | 'reverted' | 'abandoned';
      sessions: number;
      billed_cost_microcents: string;
      unknown_cost_requests: number;
    }>(
      `SELECT y.label,
              COUNT(*)::int AS sessions,
              COALESCE(SUM(m.billed_cost_microcents), 0)::bigint AS billed_cost_microcents,
              COALESCE(SUM(m.unknown_cost_requests), 0)::bigint AS unknown_cost_requests
         FROM session_yield y
         JOIN session_metrics m ON m.team_id = y.team_id AND m.session_id = y.session_id
        WHERE y.team_id = $1
          AND y.session_ended_at >= NOW() - INTERVAL '30 days'
        GROUP BY y.label`,
      [teamId],
    );

    const counts = { productive: 0, reverted: 0, abandoned: 0 };
    const costs = { productive: 0, reverted: 0, abandoned: 0 };
    let unknownCostRequests = 0;
    for (const row of summary.rows) {
      counts[row.label] = row.sessions;
      costs[row.label] = Number(row.billed_cost_microcents) / MICROCENTS_TO_USD;
      unknownCostRequests += Number(row.unknown_cost_requests ?? 0);
    }
    const totalSessions = counts.productive + counts.reverted + counts.abandoned;
    const totalCostUsd = costs.productive + costs.reverted + costs.abandoned;
    const yieldPct =
      totalSessions > 0 ? Math.round((counts.productive / totalSessions) * 100) : 0;

    // 30-day daily timeseries for yield%.
    const daily = await pool.query<{
      day: Date;
      productive: number;
      total: number;
    }>(
      `SELECT date_trunc('day', session_ended_at) AS day,
              COUNT(*) FILTER (WHERE label = 'productive')::int AS productive,
              COUNT(*)::int AS total
         FROM session_yield
        WHERE team_id = $1
          AND session_ended_at >= NOW() - INTERVAL '30 days'
        GROUP BY date_trunc('day', session_ended_at)
        ORDER BY day ASC`,
      [teamId],
    );

    const dailyYield = daily.rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      yield_pct: row.total > 0 ? Math.round((row.productive / row.total) * 100) : 0,
      productive: row.productive,
      total: row.total,
    }));

    // Recent labelled sessions, capped per label so the empty buckets still
    // render rather than getting drowned out by abandons.
    const recent = await pool.query<YieldRow>(
      `SELECT y.session_id, y.label, y.matched_commit_sha, y.matched_commit_repo,
              y.matched_commit_at, y.session_ended_at::text AS session_ended_at,
              m.primary_model, m.billed_cost_microcents::text AS billed_cost_microcents,
              m.unknown_cost_requests
         FROM session_yield y
         JOIN session_metrics m ON m.team_id = y.team_id AND m.session_id = y.session_id
        WHERE y.team_id = $1
          AND y.session_ended_at >= NOW() - INTERVAL '30 days'
        ORDER BY y.session_ended_at DESC
        LIMIT 50`,
      [teamId],
    );

    return {
      data: {
        summary: {
          total_sessions: totalSessions,
          productive_sessions: counts.productive,
          reverted_sessions: counts.reverted,
          abandoned_sessions: counts.abandoned,
          yield_pct: yieldPct,
          total_billed_spend_usd: Math.round(totalCostUsd * 100) / 100,
          productive_cost_usd: Math.round(costs.productive * 100) / 100,
          wasted_cost_usd:
            Math.round((costs.reverted + costs.abandoned) * 100) / 100,
          unknown_cost_requests: unknownCostRequests,
          actual_costs_qualified: unknownCostRequests === 0,
        },
        daily: dailyYield,
        recent: recent.rows,
      },
      error: null,
    };
  } catch (err) {
    console.error('Yield metrics error:', err);
    return {
      data: null,
      error: 'Unable to load yield metrics. Check the dashboard database connection and try again.',
    };
  }
}

function labelStyle(label: 'productive' | 'reverted' | 'abandoned') {
  if (label === 'productive') return 'bg-emerald-500/[0.12] text-emerald-300';
  if (label === 'reverted') return 'bg-amber-500/[0.12] text-amber-300';
  return 'bg-neutral-500/[0.12] text-neutral-400';
}

export default async function YieldPage() {
  const result = await getYieldData();
  const data = result.data;

  const isEmpty = !result.error && (!data || data.summary.total_sessions === 0);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white">Yield</h2>
        <p className="mt-1 text-neutral-400">
          What fraction of your AI sessions produced shipped code? A session is{' '}
          <span className="text-emerald-300">productive</span> if a commit
          authored within 24h landed in main and stayed there;{' '}
          <span className="text-amber-300">reverted</span> if that commit was
          reverted within 24h; otherwise{' '}
          <span className="text-neutral-300">abandoned</span>.
        </p>
      </div>

      {result.error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4 text-sm text-red-200">
          {result.error}
        </div>
      ) : isEmpty ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <div className="mb-4 flex justify-center">
            <Target className="h-10 w-10 text-neutral-600" />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-white">
            No yield data yet
          </h3>
          <p className="mx-auto max-w-md text-sm text-neutral-500">
            The yield correlator runs hourly and labels a session once its
            24-hour window has fully elapsed. Correlation is limited to
            Layer-connected teams — teams whose RouteShift credentials are
            issued by Layer, or that carry a Layer tenant id — whose commits
            are matched against routed sessions. Self-serve teams are not
            eligible for yield correlation.
          </p>
        </div>
      ) : (
        <>
          <CostQualificationNotice unknownCostRequests={data!.summary.unknown_cost_requests} />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              title="Yield"
              value={`${data!.summary.yield_pct}%`}
              subtitle={`${data!.summary.productive_sessions} of ${data!.summary.total_sessions} sessions`}
            />
            <KpiCard
              title="Productive spend"
              value={`$${data!.summary.productive_cost_usd.toFixed(2)}`}
              subtitle="On sessions that shipped"
            />
            <KpiCard
              title="Wasted spend"
              value={`$${data!.summary.wasted_cost_usd.toFixed(2)}`}
              subtitle="Reverted + abandoned"
            />
            <KpiCard
              title="Sessions"
              value={data!.summary.total_sessions.toLocaleString()}
              subtitle="Last 30 days"
            />
          </div>

          <div>
            <h3 className="mb-4 text-lg font-semibold text-white">
              Daily yield
            </h3>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4">
              {data!.daily.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  No labelled sessions in the last 30 days.
                </p>
              ) : (
                <div className="flex h-40 items-end gap-1">
                  {data!.daily.map((d) => (
                    <div
                      key={d.day}
                      className="group relative flex flex-1 flex-col items-center justify-end"
                      title={`${d.day}: ${d.productive}/${d.total} productive (${d.yield_pct}%)`}
                    >
                      <div
                        className="w-full rounded-t bg-emerald-500/60 transition-colors group-hover:bg-emerald-400"
                        style={{ height: `${Math.max(d.yield_pct, 2)}%` }}
                      />
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-xs text-neutral-500">
                Bars show productive% per day over the last 30 days. Hover for
                counts.
              </p>
            </div>
          </div>

          <div>
            <h3 className="mb-4 text-lg font-semibold text-white">
              Recent sessions
            </h3>
            <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.03]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Session</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Billed spend</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Ended</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data!.recent.map((row) => {
                    const cost =
                      Number(row.billed_cost_microcents) / MICROCENTS_TO_USD;
                    return (
                      <TableRow key={row.session_id}>
                        <TableCell className="font-mono text-xs text-neutral-300">
                          <Link
                            href={`/activity?session=${encodeURIComponent(row.session_id)}`}
                            className="hover:text-emerald-300"
                          >
                            {row.session_id.slice(0, 14)}…
                          </Link>
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${labelStyle(row.label)}`}
                          >
                            {row.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-neutral-400">
                          {row.primary_model ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs text-neutral-300">
                          ${cost.toFixed(4)}{row.unknown_cost_requests > 0 ? ' (lower bound)' : ''}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-neutral-400">
                          {row.matched_commit_sha
                            ? `${row.matched_commit_repo ?? ''}@${row.matched_commit_sha.slice(0, 7)}`
                            : '—'}
                        </TableCell>
                        <TableCell className="text-xs text-neutral-500" suppressHydrationWarning>
                          {new Date(row.session_ended_at).toLocaleString()}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
