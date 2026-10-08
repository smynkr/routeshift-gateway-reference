import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';
import {
  buildSavingsReceiptCsv,
  parseReceiptMonth,
  type SavingsReceiptDailyRow,
  type SavingsReceiptModelRow,
  type SavingsReceiptSummary,
} from '@/lib/savings-receipt';

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(request.url);
    const requestedMonth = url.searchParams.get('month');
    const month = parseReceiptMonth(requestedMonth);
    if (!month) return NextResponse.json({ error: 'Invalid month. Use YYYY-MM.' }, { status: 400 });

    const demoActive = await isDemoActive();
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return NextResponse.json({ error: 'No team context is available for this session.' }, { status: 400 });

    const pool = getPool();
    const [summaryResult, dailyResult, modelResult] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total_requests,
           COALESCE(SUM(original_cost_microcents), 0)::bigint AS total_original_microcents,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_actual_microcents,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS total_billed_microcents,
           COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS total_savings_microcents,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3`,
        [teamId, month.start, month.end],
      ),
      pool.query(
        `SELECT
           (timestamp AT TIME ZONE 'UTC')::date AS day,
           COALESCE(SUM(original_cost_microcents), 0)::bigint AS original_microcents,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS actual_microcents,
           COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS savings_microcents,
           COUNT(*)::int AS requests,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3
         GROUP BY day
         ORDER BY day`,
        [teamId, month.start, month.end],
      ),
      pool.query(
        `SELECT
           provider,
           COALESCE(model_resolved, model_requested) AS model,
           COUNT(*)::int AS requests,
           COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS savings_microcents
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3
         GROUP BY provider, COALESCE(model_resolved, model_requested)
         ORDER BY savings_microcents DESC, requests DESC`,
        [teamId, month.start, month.end],
      ),
    ]);

    const summaryRow = summaryResult.rows[0] ?? {};
    const unknownCostRequests = Number(summaryRow.unknown_cost_requests ?? 0);
    const summary: SavingsReceiptSummary = {
      month: month.label,
      totalRequests: Number(summaryRow.total_requests ?? 0),
      totalOriginalMicrocents: summaryRow.total_original_microcents ?? 0,
      totalActualMicrocents: summaryRow.total_actual_microcents ?? 0,
      totalBilledMicrocents: summaryRow.total_billed_microcents ?? 0,
      totalSavingsMicrocents: summaryRow.total_savings_microcents ?? 0,
      unknownCostRequests,
      actualCostsQualified: unknownCostRequests === 0,
      isDemo: demoActive,
    };

    const daily: SavingsReceiptDailyRow[] = dailyResult.rows.map((row) => ({
      day: row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day),
      originalMicrocents: row.original_microcents ?? 0,
      actualMicrocents: row.actual_microcents ?? 0,
      savingsMicrocents: row.savings_microcents ?? 0,
      requests: Number(row.requests ?? 0),
      unknownCostRequests: Number(row.unknown_cost_requests ?? 0),
    }));
    const byModel: SavingsReceiptModelRow[] = modelResult.rows.map((row) => ({
      provider: String(row.provider ?? ''),
      model: String(row.model ?? ''),
      requests: Number(row.requests ?? 0),
      savingsMicrocents: row.savings_microcents ?? 0,
    }));
    const monthKey = `${month.start.getUTCFullYear()}-${String(month.start.getUTCMonth() + 1).padStart(2, '0')}`;
    const filenamePrefix = demoActive ? 'demo-' : '';

    const response = new NextResponse(buildSavingsReceiptCsv(summary, daily, byModel), {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${filenamePrefix}savings-receipt-${monthKey}.csv"`,
        'Content-Type': 'text/csv; charset=utf-8',
      },
    });
    return response;
  } catch (err) {
    console.error('Savings receipt error:', err);
    return NextResponse.json({ error: 'Failed to build savings receipt' }, { status: 500 });
  }
}
