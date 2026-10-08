// LAY-316: side-by-side metrics for two models over the team's traffic.
//
// GET /api/models/compare?a=<canonical>&b=<canonical>&period=24h|7d|30d|all
// Returns per-model: billed spend, routing-only cost, total tokens, cache hit
// rate, p50/p95/p99 latency, one-shot rate, billed $/successful edit, and
// output tokens per call.

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

interface ModelMetrics {
  model: string;
  requests: number;
  /** Customer spend: routing actual cost plus plugin charges. */
  total_cost_microcents: number;
  /** Routing-only actual cost; use with routing-only savings metrics. */
  routing_cost_microcents: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
  total_tokens: number;
  output_tokens: number;
  cache_hits: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  p99_latency_ms: number | null;
  one_shot_rate: number | null;
  edit_turns: number;
  retry_turns: number;
  /** Qualification for billed session spend per successful edit. */
  billed_cost_per_successful_edit_unknown_cost_requests: number;
  billed_cost_per_successful_edit_qualified: boolean;
  /** Billed session spend (routing actual cost plus plugin charges) per successful edit. */
  billed_cost_per_successful_edit_microcents: number | null;
  /** Backwards-compatible routing-only value for legacy consumers. */
  cost_per_successful_edit_microcents: number | null;
}

function periodToHours(period: string): number | null {
  if (period === '24h') return 24;
  if (period === '7d') return 168;
  if (period === '30d') return 720;
  if (period === 'all') return null;
  return 168;
}

async function fetchMetrics(pool: ReturnType<typeof getPool>, teamId: string, model: string, hours: number | null): Promise<ModelMetrics> {
  const intervalClause = hours == null ? '' : 'AND timestamp >= NOW() - make_interval(hours => $3)';
  const params: unknown[] = [teamId, model];
  if (hours != null) params.push(hours);

  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*)::bigint AS requests,
      COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS total_cost_microcents,
      COALESCE(SUM(actual_cost_microcents), 0)::bigint AS routing_cost_microcents,
      COUNT(*) FILTER (WHERE actual_cost_known = false)::bigint AS unknown_cost_requests,
      COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
      COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
      COUNT(*) FILTER (WHERE COALESCE(cache_hit, false))::bigint AS cache_hits,
      COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY total_latency_ms), 0)::int AS p50,
      COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_latency_ms), 0)::int AS p95,
      COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY total_latency_ms), 0)::int AS p99
    FROM request_logs
    WHERE team_id = $1 AND model_resolved = $2 ${intervalClause}
    `,
    params,
  );
  const r = rows[0];
  const requests = Number(r?.requests ?? 0);

  // One-shot rollup. Sessions can span out of the request window — we
  // bound on session_metrics.last_request_at instead so we're consistent
  // with the /analytics by-model table.
  const oneShotInterval = hours == null ? '' : 'AND last_request_at >= NOW() - make_interval(hours => $3)';
  const { rows: osRows } = await pool.query(
    `
    SELECT
      COALESCE(SUM(edit_turns), 0)::int AS edit_turns,
      COALESCE(SUM(retry_turns), 0)::int AS retry_turns,
      COALESCE(SUM(total_cost_microcents), 0)::bigint AS routing_cost_microcents,
      COALESCE(SUM(billed_cost_microcents), 0)::bigint AS billed_cost_microcents,
      COALESCE(SUM(unknown_cost_requests), 0)::bigint AS unknown_cost_requests
    FROM session_metrics
    WHERE team_id = $1 AND primary_model = $2 ${oneShotInterval}
    `,
    params,
  );
  const os = osRows[0];
  const editTurns = Number(os?.edit_turns ?? 0);
  const retryTurns = Number(os?.retry_turns ?? 0);
  const successful = editTurns - retryTurns;
  const oneShotRate = editTurns > 0 ? successful / editTurns : null;
  const routingOneShotCost = Number(os?.routing_cost_microcents ?? 0);
  const billedOneShotCost = Number(os?.billed_cost_microcents ?? 0);
  const billedCostPerSuccessfulEditUnknownCostRequests = Number(os?.unknown_cost_requests ?? 0);
  const routingCostPerSuccessfulEdit = successful > 0 ? routingOneShotCost / successful : null;
  const billedCostPerSuccessfulEdit = successful > 0 ? billedOneShotCost / successful : null;

  return {
    model,
    requests,
    total_cost_microcents: Number(r?.total_cost_microcents ?? 0),
    routing_cost_microcents: Number(r?.routing_cost_microcents ?? 0),
    unknown_cost_requests: Number(r?.unknown_cost_requests ?? 0),
    actual_costs_qualified: Number(r?.unknown_cost_requests ?? 0) === 0,
    total_tokens: Number(r?.total_tokens ?? 0),
    output_tokens: Number(r?.output_tokens ?? 0),
    cache_hits: Number(r?.cache_hits ?? 0),
    p50_latency_ms: requests > 0 ? Number(r?.p50 ?? 0) : null,
    p95_latency_ms: requests > 0 ? Number(r?.p95 ?? 0) : null,
    p99_latency_ms: requests > 0 ? Number(r?.p99 ?? 0) : null,
    one_shot_rate: oneShotRate,
    edit_turns: editTurns,
    retry_turns: retryTurns,
    billed_cost_per_successful_edit_microcents: billedCostPerSuccessfulEdit,
    billed_cost_per_successful_edit_unknown_cost_requests: billedCostPerSuccessfulEditUnknownCostRequests,
    billed_cost_per_successful_edit_qualified: billedCostPerSuccessfulEditUnknownCostRequests === 0,
    cost_per_successful_edit_microcents: routingCostPerSuccessfulEdit,
  };
}

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return NextResponse.json({ error: 'No team context' }, { status: 403 });

    const { searchParams } = new URL(request.url);
    const a = searchParams.get('a');
    const b = searchParams.get('b');
    const period = searchParams.get('period') ?? '7d';
    if (!a || !b) {
      return NextResponse.json({ error: 'a and b query params required' }, { status: 400 });
    }
    const hours = periodToHours(period);

    const pool = getPool();
    const [aMetrics, bMetrics] = await Promise.all([
      fetchMetrics(pool, teamId, a, hours),
      fetchMetrics(pool, teamId, b, hours),
    ]);

    return NextResponse.json({ a: aMetrics, b: bMetrics, period });
  } catch (err) {
    console.error('models/compare error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
