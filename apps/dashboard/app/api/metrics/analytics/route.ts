import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

function normalizeTimestamp(value: unknown): string {
  const date = value instanceof Date
    ? value
    : new Date(typeof value === 'string' ? value : String(value));
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid analytics range timestamp');
  return date.toISOString();
}

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = await getEffectiveTeamId(member.teamId);

    const { searchParams } = new URL(request.url);
    const period = searchParams.get('period') ?? '7d';
    if (period !== '24h' && period !== '7d' && period !== '30d') {
      return NextResponse.json({ error: 'Invalid period' }, { status: 400 });
    }
    const hours = period === '24h' ? 24 : period === '30d' ? 720 : 168;
    const pool = getPool();
    const rangeResult = await pool.query(
      `SELECT snapshot.captured_at - make_interval(hours => $1) AS "from",
              snapshot.captured_at AS "to"
         FROM (SELECT NOW() AS captured_at) AS snapshot`,
      [hours],
    );
    const rangeRow = rangeResult.rows[0];
    if (!rangeRow?.from || !rangeRow?.to) {
      throw new Error('Analytics range anchor unavailable');
    }
    const range = {
      from: normalizeTimestamp(rangeRow.from),
      to: normalizeTimestamp(rangeRow.to),
    };

    const [costByModel, costByProvider, dailyTrend, errorsByProvider, cacheStats, reasoningByModel] = await Promise.all([
      // Cost breakdown by model
      pool.query(
        `SELECT
           model_resolved AS model,
           provider,
           COUNT(*)::int AS requests,
           -- total_cost remains routing-only for compatibility with the
           -- routing/savings series. Customer spend is billed_cost.
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_cost,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost,
           COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS total_savings,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
           COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= $2 AND timestamp <= $3
         GROUP BY model_resolved, provider
         ORDER BY billed_cost DESC`,
        [teamId, range.from, range.to],
      ),

      // Provider comparison
      pool.query(
        `SELECT
           provider,
           COUNT(*)::int AS requests,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS total_cost,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost,
           COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS total_savings,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
           COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
           COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_latency_ms), 0)::int AS p95_latency_ms,
           ROUND(COUNT(*) FILTER (WHERE status_code >= 400)::numeric / NULLIF(COUNT(*), 0)::numeric, 4) AS error_rate,
           COUNT(*) FILTER (WHERE COALESCE(cache_hit, false) = true)::int AS cache_hits
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= $2 AND timestamp <= $3
         GROUP BY provider
         ORDER BY requests DESC`,
        [teamId, range.from, range.to],
      ),

      // Daily cost trend
      pool.query(
        `SELECT
           date_trunc('day', timestamp)::date AS day,
           -- cost is routing actual; billed cost adds plugin charges without
           -- changing original-cost or routing-savings semantics.
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS cost,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost,
           COALESCE(SUM(original_cost_microcents), 0)::bigint AS original_cost,
           COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE actual_cost_known = true), 0)::bigint AS savings,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
           COUNT(*)::int AS requests,
           COUNT(*) FILTER (WHERE COALESCE(cache_hit, false) = true)::int AS cache_hits
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= $2 AND timestamp <= $3
         GROUP BY date_trunc('day', timestamp)::date
         ORDER BY day`,
        [teamId, range.from, range.to],
      ),

      // Errors by provider
      pool.query(
        `SELECT
           provider,
           status_code,
           error_type,
           COUNT(*)::int AS count
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= $2 AND timestamp <= $3
           AND status_code >= 400
         GROUP BY provider, status_code, error_type
         ORDER BY count DESC
         LIMIT 20`,
        [teamId, range.from, range.to],
      ),

      // Cache effectiveness
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(cache_hit, false) = true)::int AS hits,
           COALESCE(SUM(GREATEST(savings_microcents, 0)) FILTER (WHERE COALESCE(cache_hit, false) = true), 0)::bigint AS cache_savings
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= $2 AND timestamp <= $3`,
        [teamId, range.from, range.to],
      ),
      // Reasoning usage breakdown by model
      pool.query(
        `SELECT
           provider,
           model_resolved AS model,
           COUNT(*)::int AS requests,
           COUNT(reasoning_tokens)::int AS reasoning_token_requests,
           COALESCE(SUM(reasoning_tokens), 0)::bigint AS reasoning_tokens,
           COALESCE(SUM(output_tokens) FILTER (WHERE reasoning_tokens IS NOT NULL), 0)::bigint AS output_tokens,
           CASE
             WHEN COUNT(reasoning_tokens) = 0
               OR COALESCE(SUM(output_tokens) FILTER (WHERE reasoning_tokens IS NOT NULL), 0) = 0 THEN NULL
             ELSE SUM(reasoning_tokens)::numeric
               / SUM(output_tokens) FILTER (WHERE reasoning_tokens IS NOT NULL)::numeric
           END AS reasoning_output_share,
           SUM(reasoning_cost_microcents)::bigint AS reasoning_cost_microcents,
           COUNT(*) FILTER (
             WHERE reasoning_tokens IS NOT NULL AND reasoning_cost_microcents IS NULL
           )::int AS unknown_reasoning_cost_requests
         FROM request_logs
         WHERE team_id = $1 AND timestamp >= $2 AND timestamp <= $3
         GROUP BY provider, model_resolved
         ORDER BY reasoning_tokens DESC, requests DESC`,
        [teamId, range.from, range.to],
      ),
    ]);

    return NextResponse.json({
      range,
      cost_by_model: costByModel.rows.map((r) => ({
        model: r.model,
        provider: r.provider,
        requests: r.requests,
        total_cost: Number(r.total_cost),
        total_billed_cost: Number(r.billed_cost),
        total_savings: Number(r.total_savings),
        unknown_cost_requests: Number(r.unknown_cost_requests ?? 0),
        actual_costs_qualified: Number(r.unknown_cost_requests ?? 0) === 0,
        avg_latency_ms: r.avg_latency_ms,
        total_tokens: Number(r.total_tokens),
      })),
      reasoning_by_model: reasoningByModel.rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        requests: Number(r.requests),
        reasoning_token_requests: Number(r.reasoning_token_requests),
        reasoning_tokens: Number(r.reasoning_tokens),
        output_tokens: Number(r.output_tokens),
        reasoning_output_share: r.reasoning_output_share === null ? null : Number(r.reasoning_output_share),
        reasoning_cost_microcents:
          r.reasoning_cost_microcents === null ? null : Number(r.reasoning_cost_microcents),
        unknown_reasoning_cost_requests: Number(r.unknown_reasoning_cost_requests),
      })),
      provider_comparison: costByProvider.rows.map((r) => ({
        provider: r.provider,
        requests: r.requests,
        total_cost: Number(r.total_cost),
        total_billed_cost: Number(r.billed_cost),
        total_savings: Number(r.total_savings),
        unknown_cost_requests: Number(r.unknown_cost_requests ?? 0),
        actual_costs_qualified: Number(r.unknown_cost_requests ?? 0) === 0,
        avg_latency_ms: r.avg_latency_ms,
        p95_latency_ms: r.p95_latency_ms,
        error_rate: Number(r.error_rate ?? 0),
        cache_hits: r.cache_hits,
      })),
      daily_trend: dailyTrend.rows.map((r) => ({
        day: r.day,
        cost: Number(r.cost),
        billed_cost: Number(r.billed_cost),
        original_cost: Number(r.original_cost),
        savings: Number(r.savings),
        unknown_cost_requests: Number(r.unknown_cost_requests ?? 0),
        actual_costs_qualified: Number(r.unknown_cost_requests ?? 0) === 0,
        requests: r.requests,
        cache_hits: r.cache_hits,
      })),
      errors: errorsByProvider.rows,
      cache: {
        total: cacheStats.rows[0]?.total ?? 0,
        hits: cacheStats.rows[0]?.hits ?? 0,
        savings: Number(cacheStats.rows[0]?.cache_savings ?? 0),
      },
    });
  } catch (err) {
    console.error('Analytics error:', err);
    return NextResponse.json({ error: 'Failed to load analytics' }, { status: 500 });
  }
}
