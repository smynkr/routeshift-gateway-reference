import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

const MICROCENTS_TO_USD = 100_000_000;

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = await getEffectiveTeamId(member.teamId);

    const pool = getPool();

    // Summary metrics for the last 7 days
    const summaryResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_requests,
         -- Routing actual and savings stay independent from customer billing.
         COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_cost_microcents,
         COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS total_billed_cost_microcents,
         COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS total_savings_microcents,
         COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
         COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
         CASE WHEN COUNT(*) > 0
           THEN ROUND(COUNT(*) FILTER (WHERE status_code >= 400)::numeric / COUNT(*)::numeric, 4)
           ELSE 0
         END AS error_rate
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - INTERVAL '7 days'`,
      [teamId],
    );

    const summary = summaryResult.rows[0];
    const totalRoutingCostUsd = Number(summary.total_cost_microcents) / MICROCENTS_TO_USD;
    const totalBilledSpendUsd = Number(summary.total_billed_cost_microcents) / MICROCENTS_TO_USD;
    const totalSavingsUsd = Number(summary.total_savings_microcents) / MICROCENTS_TO_USD;
    const totalOriginal = totalRoutingCostUsd + totalSavingsUsd;
    const savingsPercent = totalOriginal > 0
      ? Math.round((totalSavingsUsd / totalOriginal) * 100)
      : 0;

    // Hourly timeseries for the last 7 days
    const timeseriesResult = await pool.query(
      `SELECT
         date_trunc('hour', timestamp) AS hour,
         COUNT(*)::int AS requests,
         COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms
       FROM request_logs
       WHERE team_id = $1
         AND timestamp >= NOW() - INTERVAL '7 days'
       GROUP BY date_trunc('hour', timestamp)
       ORDER BY hour`,
      [teamId],
    );

    const timeseries = timeseriesResult.rows.map((row) => ({
      hour: row.hour.toISOString(),
      requests: row.requests,
      avg_latency_ms: row.avg_latency_ms,
    }));

    const [{ rows: [keysRow] }, { rows: [rulesRow] }] = await Promise.all([
      pool.query(
        'SELECT COUNT(*)::int AS count FROM api_keys WHERE team_id = $1 AND revoked_at IS NULL',
        [teamId],
      ),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM routing_rules WHERE team_id = $1 AND enabled = true',
        [teamId],
      ),
    ]);
    const activeKeys = keysRow.count;
    const activeRules = rulesRow.count;

    return NextResponse.json({
      summary: {
        total_requests: summary.total_requests,
        // Keep the legacy generic field aligned with the customer-facing
        // total, while exposing explicit routing/billing names for callers.
        total_cost_usd: Math.round(totalBilledSpendUsd * 100) / 100,
        billed_spend_usd: Math.round(totalBilledSpendUsd * 100) / 100,
        actual_routing_cost_usd: Math.round(totalRoutingCostUsd * 100) / 100,
        total_savings_usd: Math.round(totalSavingsUsd * 100) / 100,
        routing_savings_usd: Math.round(totalSavingsUsd * 100) / 100,
        savings_percent: savingsPercent,
        routing_savings_percent: savingsPercent,
        unknown_cost_requests: Number(summary.unknown_cost_requests ?? 0),
        actual_costs_qualified: Number(summary.unknown_cost_requests ?? 0) === 0,
        avg_latency_ms: summary.avg_latency_ms,
        error_rate: Number(summary.error_rate),
        active_keys: activeKeys,
        active_rules: activeRules,
      },
      timeseries,
    });
  } catch (err) {
    console.error('Overview metrics error:', err);
    return NextResponse.json(
      { error: 'Failed to load metrics' },
      { status: 500 },
    );
  }
}
