import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

const MICROCENTS_TO_USD = 100_000_000;

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = await getEffectiveTeamId(member.teamId);

    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') ?? '7d';
    const hours = period === '24h' ? 24 : period === '30d' ? 720 : 168;

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

    return NextResponse.json({
      summary: {
        total_original_usd: Math.round(totalOriginalUsd * 100) / 100,
        total_actual_usd: Math.round(totalActualUsd * 100) / 100,
        actual_routing_cost_usd: Math.round(totalActualUsd * 100) / 100,
        billed_spend_usd: Math.round(totalBilledSpendUsd * 100) / 100,
        total_savings_usd: Math.round(totalSavingsUsd * 100) / 100,
        routing_savings_usd: Math.round(totalSavingsUsd * 100) / 100,
        savings_percent: savingsPercent,
        total_requests: s.total_requests,
        unknown_cost_requests: Number(s.unknown_cost_requests ?? 0),
        actual_costs_qualified: Number(s.unknown_cost_requests ?? 0) === 0,
      },
      timeseries,
    });
  } catch (err) {
    console.error('Savings metrics error:', err);
    return NextResponse.json(
      { error: 'Failed to load metrics' },
      { status: 500 },
    );
  }
}
