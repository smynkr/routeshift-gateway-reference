// LAY-314 phase 3: one-shot rate API.
//
// Reads from session_metrics, populated by the proxy's 5-min aggregation
// cron (apps/proxy/src/observability/session-aggregator.ts). Sessions stay
// out of session_metrics until they've been idle ≥30 min, so this endpoint
// reflects closed-session truth, not in-flight work.
//
// Query params:
//   period: 24h | 7d | 30d (default 7d)
//
// Returns:
//   summary: { sessions, edit_turns, retry_turns, one_shot_rate }
//   by_model: rows of { model, sessions, edit_turns, retry_turns,
//                       one_shot_rate, billed_cost_microcents,
//                       billed_cost_per_successful_edit_microcents }

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

function periodToHours(period: string): number {
  if (period === '24h') return 24;
  if (period === '30d') return 720;
  return 168;
}

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) {
      return NextResponse.json({ error: 'No team context' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') ?? '7d';
    const hours = periodToHours(period);

    const pool = getPool();

    const [summaryRes, byModelRes] = await Promise.all([
      pool.query(
        `
        SELECT
          COUNT(*)::int AS sessions,
          COALESCE(SUM(edit_turns), 0)::int AS edit_turns,
          COALESCE(SUM(retry_turns), 0)::int AS retry_turns
        FROM session_metrics
        WHERE team_id = $1
          AND last_request_at >= NOW() - make_interval(hours => $2)
        `,
        [teamId, hours],
      ),
      pool.query(
        `
        SELECT
          primary_model AS model,
          COUNT(*)::int AS sessions,
          COALESCE(SUM(edit_turns), 0)::int AS edit_turns,
          COALESCE(SUM(retry_turns), 0)::int AS retry_turns,
          COALESCE(SUM(total_cost_microcents), 0)::bigint AS total_cost_microcents,
          COALESCE(SUM(billed_cost_microcents), 0)::bigint AS billed_cost_microcents,
          COALESCE(SUM(unknown_cost_requests), 0)::bigint AS unknown_cost_requests
        FROM session_metrics
        WHERE team_id = $1
          AND last_request_at >= NOW() - make_interval(hours => $2)
          AND primary_model IS NOT NULL
        GROUP BY primary_model
        ORDER BY edit_turns DESC, sessions DESC
        `,
        [teamId, hours],
      ),
    ]);

    const summary = summaryRes.rows[0] ?? { sessions: 0, edit_turns: 0, retry_turns: 0 };
    const successful_edits = Number(summary.edit_turns) - Number(summary.retry_turns);
    const summary_one_shot_rate =
      Number(summary.edit_turns) > 0
        ? successful_edits / Number(summary.edit_turns)
        : null;

    const by_model = byModelRes.rows.map((row) => {
      const editTurns = Number(row.edit_turns);
      const retryTurns = Number(row.retry_turns);
      const successful = editTurns - retryTurns;
      const routingCost = Number(row.total_cost_microcents ?? 0);
      const billedCost = Number(row.billed_cost_microcents ?? 0);
      const unknownCostRequests = Number(row.unknown_cost_requests ?? 0);
      const routingCostPerSuccessfulEdit = successful > 0 ? routingCost / successful : null;
      const billedCostPerSuccessfulEdit = successful > 0 ? billedCost / successful : null;
      return {
        model: row.model as string,
        sessions: Number(row.sessions),
        edit_turns: editTurns,
        retry_turns: retryTurns,
        one_shot_rate: editTurns > 0 ? successful / editTurns : null,
        billed_cost_microcents: billedCost,
        billed_cost_per_successful_edit_microcents: billedCostPerSuccessfulEdit,
        unknown_cost_requests: unknownCostRequests,
        actual_costs_qualified: unknownCostRequests === 0,
        // Existing generic fields retain their routing-only semantics.
        total_cost_microcents: routingCost,
        cost_per_successful_edit_microcents: routingCostPerSuccessfulEdit,
      };
    });

    return NextResponse.json({
      period,
      summary: {
        sessions: Number(summary.sessions),
        edit_turns: Number(summary.edit_turns),
        retry_turns: Number(summary.retry_turns),
        one_shot_rate: summary_one_shot_rate,
      },
      by_model,
    });
  } catch (err) {
    console.error('one-shot endpoint error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
