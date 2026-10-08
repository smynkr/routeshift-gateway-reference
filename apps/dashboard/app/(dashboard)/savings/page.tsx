import { KpiCard } from '@/components/stats/kpi-card';
import { SavingsChart } from '@/components/charts/savings-chart';
import { CostQualificationNotice } from '@/components/cost-qualification-notice';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';
import { Zap } from 'lucide-react';
import Link from 'next/link';

export const metadata = { title: 'Savings' };
export const dynamic = 'force-dynamic';

const MICROCENTS_TO_USD = 100_000_000;

async function getSavingsData() {
  try {
    const member = await requireTeamMembership();
    if (!member) return { data: null, error: null };
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return { data: null, error: 'No team context is available for this session.' };

    const hours = 168; // 7 days

    const pool = getPool();

    // Summary for the period
    const summaryResult = await pool.query(
      `SELECT
         COALESCE(SUM(original_cost_microcents), 0)::bigint AS total_original_microcents,
         COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_actual_microcents,
         COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS total_billed_spend_microcents,
         COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS total_savings_microcents,
         COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
         COUNT(*)::int AS total_requests
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - make_interval(hours => $2)`,
      [teamId, hours],
    );

    const s = summaryResult.rows[0];
    const totalOriginalUsd = Number(s.total_original_microcents) / MICROCENTS_TO_USD;
    const totalActualUsd = Number(s.total_actual_microcents) / MICROCENTS_TO_USD;
    const totalBilledSpendUsd = Number(s.total_billed_spend_microcents ?? 0) / MICROCENTS_TO_USD;
    const totalSavingsUsd = Number(s.total_savings_microcents) / MICROCENTS_TO_USD;
    const savingsPercent = totalOriginalUsd > 0
      ? Math.round((totalSavingsUsd / totalOriginalUsd) * 100)
      : 0;

    // Hourly timeseries
    const timeseriesResult = await pool.query(
      `SELECT
         date_trunc('hour', timestamp) AS hour,
         COALESCE(SUM(original_cost_microcents), 0)::bigint AS original_microcents,
         COALESCE(SUM(actual_cost_microcents), 0)::bigint AS actual_microcents,
         COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_spend_microcents,
         COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS savings_microcents,
         COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
         COUNT(*)::int AS requests
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - make_interval(hours => $2)
       GROUP BY date_trunc('hour', timestamp)
       ORDER BY hour`,
      [teamId, hours],
    );

    const timeseries = timeseriesResult.rows.map((row) => ({
      hour: row.hour.toISOString(),
      original_cost_usd: Math.round((Number(row.original_microcents) / MICROCENTS_TO_USD) * 10000) / 10000,
      actual_cost_usd: Math.round((Number(row.actual_microcents) / MICROCENTS_TO_USD) * 10000) / 10000,
      billed_spend_usd: Math.round((Number(row.billed_spend_microcents ?? 0) / MICROCENTS_TO_USD) * 10000) / 10000,
      savings_usd: Math.round((Number(row.savings_microcents) / MICROCENTS_TO_USD) * 10000) / 10000,
      requests: row.requests,
      unknown_cost_requests: Number(row.unknown_cost_requests ?? 0),
      actual_costs_qualified: Number(row.unknown_cost_requests ?? 0) === 0,
    }));

    return {
      data: {
        summary: {
          total_original_usd: Math.round(totalOriginalUsd * 100) / 100,
          total_actual_usd: Math.round(totalActualUsd * 100) / 100,
          total_routing_cost_usd: Math.round(totalActualUsd * 100) / 100,
          total_billed_spend_usd: Math.round(totalBilledSpendUsd * 100) / 100,
          total_savings_usd: Math.round(totalSavingsUsd * 100) / 100,
          savings_percent: savingsPercent,
          total_requests: s.total_requests,
          unknown_cost_requests: Number(s.unknown_cost_requests ?? 0),
          actual_costs_qualified: Number(s.unknown_cost_requests ?? 0) === 0,
        },
        timeseries,
      },
      error: null,
    };
  } catch (err) {
    console.error('Savings metrics error:', err);
    return {
      data: null,
      error: 'Unable to load savings metrics. Check the dashboard database connection and try again.',
    };
  }
}

export default async function SavingsPage() {
  const result = await getSavingsData();
  const data = result.data;

  const isEmpty = !result.error && (!data || data.summary.total_requests === 0);

  const currentMonth = new Date();
  const receiptMonth = `${currentMonth.getUTCFullYear()}-${String(currentMonth.getUTCMonth() + 1).padStart(2, '0')}`;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white">Cost Savings</h2>
          <p className="mt-1 text-neutral-400">See how much RouteShift is saving you with intelligent routing.</p>
        </div>
        <a
          href={`/api/metrics/savings-receipt?month=${receiptMonth}`}
          download
          className="inline-flex min-h-10 items-center justify-center rounded-lg border border-white/[0.08] px-3 text-sm font-medium text-neutral-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
        >
          Download monthly receipt
        </a>
      </div>

      {result.error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-5 py-4 text-sm text-red-200">
          {result.error}
        </div>
      ) : isEmpty ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <div className="flex justify-center mb-4">
            <Zap className="h-10 w-10 text-neutral-600" />
          </div>
          <h3 className="text-lg font-semibold text-white mb-2">No requests yet</h3>
          <p className="text-sm text-neutral-500 max-w-md mx-auto mb-6">
            Point your application at RouteShift to start tracking costs and savings.
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
          <CostQualificationNotice unknownCostRequests={data!.summary.unknown_cost_requests} />
          {/* KPI Cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              title="Routing Savings"
              value={data ? `$${data.summary.total_savings_usd.toFixed(2)}` : '---'}
              subtitle={data ? `${data.summary.savings_percent}% routing reduction` : undefined}
            />
            <KpiCard
              title="Original Routing Cost"
              value={data ? `$${data.summary.total_original_usd.toFixed(2)}` : '---'}
              subtitle="Model list-price baseline"
            />
            <KpiCard
              title="Total Billed Spend"
              value={data ? `$${data.summary.total_billed_spend_usd.toFixed(2)}` : '---'}
              subtitle="Provider routing + plugin fees"
            />
            <KpiCard
              title="Total Requests"
              value={data ? data.summary.total_requests.toLocaleString() : '---'}
              subtitle="Last 7 days"
            />
          </div>

          {/* Savings Chart */}
          <div>
            <h3 className="mb-4 text-lg font-semibold text-white">Routing Cost Over Time</h3>
            <p className="mb-3 text-sm text-neutral-500">
              The chart keeps provider routing cost separate so its savings comparison stays like-for-like;
              billed spend above includes plugin fees.
            </p>
            <SavingsChart data={data?.timeseries ?? []} />
          </div>
        </>
      )}
    </div>
  );
}
