import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

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

    // Summary metrics
    const summaryResult = await pool.query(
      `SELECT
         COUNT(*)::int AS total_requests,
         COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
         COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
         COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_latency_ms), 0)::int AS p95_latency_ms,
         COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY total_latency_ms), 0)::int AS p99_latency_ms,
         COUNT(DISTINCT model_resolved)::int AS models_used,
         -- These fields are intentionally separate: billed spend includes
         -- plugins; routing cost is the basis for routing-only savings.
         COALESCE(SUM(actual_cost_microcents), 0)::bigint AS actual_routing_cost_microcents,
         COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_spend_microcents,
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

    const modelBreakdown = modelResult.rows.map((row) => ({
      model: row.model,
      requests: row.requests,
      avg_latency_ms: row.avg_latency_ms,
      tokens: Number(row.tokens),
    }));

    // Top 5 models for timeseries
    const topModels = modelBreakdown.slice(0, 5).map((m) => m.model);

    // Hourly timeseries for top 5 models
    let timeseries: any[] = [];
    if (topModels.length > 0) {
      const timeseriesResult = await pool.query(
        `SELECT
           date_trunc('hour', timestamp) AS hour,
           model_resolved,
           COUNT(*)::int AS requests
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - make_interval(hours => $2)
           AND model_resolved = ANY($3)
         GROUP BY date_trunc('hour', timestamp), model_resolved
         ORDER BY hour`,
        [teamId, hours, topModels],
      );

      // Pivot into {hour, model1: N, model2: N, total: N} format
      const hourMap = new Map<string, any>();
      for (const row of timeseriesResult.rows) {
        const hourKey = row.hour.toISOString();
        if (!hourMap.has(hourKey)) {
          const point: any = { hour: hourKey };
          for (const m of topModels) {
            point[m] = 0;
          }
          point.total = 0;
          hourMap.set(hourKey, point);
        }
        const point = hourMap.get(hourKey);
        point[row.model_resolved] = row.requests;
        point.total += row.requests;
      }
      timeseries = Array.from(hourMap.values());
    }

    return NextResponse.json({
      summary: {
        total_requests: s.total_requests,
        total_tokens: Number(s.total_tokens),
        avg_latency_ms: s.avg_latency_ms,
        p95_latency_ms: s.p95_latency_ms,
        p99_latency_ms: s.p99_latency_ms,
        models_used: s.models_used,
        actual_routing_cost_microcents: Number(s.actual_routing_cost_microcents ?? 0),
        billed_spend_microcents: Number(s.billed_spend_microcents ?? 0),
        unknown_cost_requests: Number(s.unknown_cost_requests ?? 0),
        actual_costs_qualified: Number(s.unknown_cost_requests ?? 0) === 0,
      },
      model_breakdown: modelBreakdown,
      timeseries,
    });
  } catch (err) {
    console.error('Usage metrics error:', err);
    return NextResponse.json(
      { error: 'Failed to load metrics' },
      { status: 500 },
    );
  }
}
