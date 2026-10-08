import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireTeamMembership } from '@/lib/rbac';
import { getEffectiveTeamId } from '@/lib/demo';

const PERIOD_HOURS = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
  '90d': 2160,
} as const;

type TokenTrackerPeriod = keyof typeof PERIOD_HOURS;

function normalizePeriod(period: string | null): TokenTrackerPeriod {
  return period && period in PERIOD_HOURS ? (period as TokenTrackerPeriod) : '7d';
}

function toNumber(value: unknown): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const teamId = await getEffectiveTeamId(member.teamId);

    const { searchParams } = new URL(request.url);
    const period = normalizePeriod(searchParams.get('period'));
    const hours = PERIOD_HOURS[period];
    const pool = getPool();

    const [summary, burnRate, daily, hourly, heatmap, models, providers, expensiveRequests] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(COALESCE(system_prompt_tokens, 0)), 0)::bigint AS system_prompt_tokens,
           -- Keep routing cost available, and use billed cost for every
           -- customer-spend surface (routing actual + plugin charges).
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS cost_microcents,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost_microcents,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
           COALESCE(AVG(total_tokens), 0)::float AS avg_tokens_per_request,
           COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY input_tokens), 0)::int AS p95_input_tokens,
           COALESCE(MAX(input_tokens), 0)::int AS max_input_tokens,
           COUNT(*) FILTER (WHERE COALESCE(cache_hit, false) = true)::int AS cache_hits,
           (
             COUNT(*) FILTER (WHERE message_hash IS NOT NULL AND message_hash <> '')
             - COUNT(DISTINCT message_hash) FILTER (WHERE message_hash IS NOT NULL AND message_hash <> '')
           )::int AS duplicate_requests
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - make_interval(hours => $2)`,
        [teamId, hours],
      ),
      pool.query(
        `SELECT
           COUNT(*)::int AS requests,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS cost_microcents,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost_microcents
           , COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - interval '6 hours'`,
        [teamId],
      ),
      pool.query(
        `SELECT
           date_trunc('day', timestamp)::date AS day,
           COUNT(*)::int AS requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(COALESCE(system_prompt_tokens, 0)), 0)::bigint AS system_prompt_tokens,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS cost_microcents,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost_microcents,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
           COUNT(*) FILTER (WHERE COALESCE(cache_hit, false) = true)::int AS cache_hits
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - make_interval(hours => $2)
         GROUP BY date_trunc('day', timestamp)::date
         ORDER BY day`,
        [teamId, hours],
      ),
      pool.query(
        `SELECT
           date_trunc('hour', timestamp) AS hour,
           COUNT(*)::int AS requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS cost_microcents,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost_microcents
           , COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - make_interval(hours => $2)
         GROUP BY date_trunc('hour', timestamp)
         ORDER BY hour`,
        [teamId, hours],
      ),
      pool.query(
        `SELECT
           EXTRACT(DOW FROM timestamp)::int AS weekday,
           EXTRACT(HOUR FROM timestamp)::int AS hour,
           COUNT(*)::int AS requests,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS cost_microcents,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost_microcents
           , COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - make_interval(hours => $2)
         GROUP BY EXTRACT(DOW FROM timestamp)::int, EXTRACT(HOUR FROM timestamp)::int
         ORDER BY weekday, hour`,
        [teamId, hours],
      ),
      pool.query(
        `SELECT
           model_resolved AS model,
           COUNT(*)::int AS requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(COALESCE(system_prompt_tokens, 0)), 0)::bigint AS system_prompt_tokens,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS cost_microcents,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost_microcents,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
           COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
           COUNT(*) FILTER (WHERE COALESCE(cache_hit, false) = true)::int AS cache_hits
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - make_interval(hours => $2)
         GROUP BY model_resolved
         ORDER BY total_tokens DESC
         LIMIT 12`,
        [teamId, hours],
      ),
      pool.query(
        `SELECT
           provider,
           COUNT(*)::int AS requests,
           COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
           COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens,
           COALESCE(SUM(actual_cost_microcents), 0)::bigint AS cost_microcents,
           COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost_microcents,
           COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests,
           COALESCE(AVG(total_latency_ms), 0)::int AS avg_latency_ms,
           COUNT(*) FILTER (WHERE status_code >= 400)::int AS errors
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - make_interval(hours => $2)
         GROUP BY provider
         ORDER BY total_tokens DESC`,
        [teamId, hours],
      ),
      pool.query(
        `SELECT
           id,
           timestamp,
           provider,
           model_resolved AS model,
           input_tokens,
           output_tokens,
           total_tokens,
           COALESCE(system_prompt_tokens, 0)::int AS system_prompt_tokens,
           actual_cost_microcents,
           actual_cost_known,
           COALESCE(plugin_cost_microcents, 0)::bigint AS plugin_cost_microcents,
           (actual_cost_microcents + COALESCE(plugin_cost_microcents, 0))::bigint AS billed_cost_microcents,
           total_latency_ms,
           cache_hit,
           status_code
         FROM request_logs
         WHERE team_id = $1
           AND timestamp >= NOW() - make_interval(hours => $2)
         ORDER BY billed_cost_microcents DESC, total_tokens DESC
         LIMIT 25`,
        [teamId, hours],
      ),
    ]);

    const s = summary.rows[0] ?? {};
    const burn = burnRate.rows[0] ?? {};
    const routingCostLast6h = toNumber(burn.cost_microcents);
    const billedCostLast6h = toNumber(burn.billed_cost_microcents);
    const tokensLast6h = toNumber(burn.total_tokens);
    const requestsLast6h = toNumber(burn.requests);

    // Burn-rate projection. The window below is a fixed recent slice of usage;
    // we extrapolate it to a day/month rather than reporting it as truth, so
    // these fields are *estimates* and are labelled as such in the client.
    const BURN_WINDOW_HOURS = 6;
    // Minimum sample before we trust the window enough to extrapolate. Bursty
    // or very-low-volume traffic over a 6h slice would otherwise be amplified
    // into wildly over-stated daily/monthly figures (a single burst -> "burning
    // $X/month"). Below this floor we decline to project (return 0) rather than
    // mislead. We still surface the raw window figures (tokens/cost) above.
    const MIN_REQUESTS_FOR_PROJECTION = 10;

    // Daily extrapolation factor: how many BURN_WINDOW_HOURS windows fit in a
    // day. Guard against divide-by-zero even though BURN_WINDOW_HOURS is fixed.
    const dailyFactor = BURN_WINDOW_HOURS > 0 ? 24 / BURN_WINDOW_HOURS : 0;
    // Use the actual number of days in the current month instead of a hardcoded
    // 30, so monthly projections track Feb/30-day/31-day months honestly.
    const now = new Date();
    const daysInCurrentMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();

    const hasEnoughData = requestsLast6h >= MIN_REQUESTS_FOR_PROJECTION;
    const projectedDailyTokens = hasEnoughData ? Math.round(tokensLast6h * dailyFactor) : 0;
    const projectedDailyRoutingCostMicrocents = hasEnoughData ? Math.round(routingCostLast6h * dailyFactor) : 0;
    const projectedMonthlyRoutingCostMicrocents = hasEnoughData
      ? Math.round(routingCostLast6h * dailyFactor * daysInCurrentMonth)
      : 0;
    const projectedDailyBilledCostMicrocents = hasEnoughData ? Math.round(billedCostLast6h * dailyFactor) : 0;
    const projectedMonthlyBilledCostMicrocents = hasEnoughData
      ? Math.round(billedCostLast6h * dailyFactor * daysInCurrentMonth)
      : 0;

    return NextResponse.json({
      period,
      hours,
      summary: {
        requests: toNumber(s.requests),
        input_tokens: toNumber(s.input_tokens),
        output_tokens: toNumber(s.output_tokens),
        total_tokens: toNumber(s.total_tokens),
        system_prompt_tokens: toNumber(s.system_prompt_tokens),
        cost_microcents: toNumber(s.cost_microcents),
        billed_cost_microcents: toNumber(s.billed_cost_microcents),
        avg_tokens_per_request: Math.round(toNumber(s.avg_tokens_per_request)),
        p95_input_tokens: toNumber(s.p95_input_tokens),
        max_input_tokens: toNumber(s.max_input_tokens),
        cache_hits: toNumber(s.cache_hits),
        duplicate_requests: toNumber(s.duplicate_requests),
        unknown_cost_requests: toNumber(s.unknown_cost_requests),
        actual_costs_qualified: toNumber(s.unknown_cost_requests) === 0,
      },
      burn_rate: {
        window_hours: BURN_WINDOW_HOURS,
        requests: requestsLast6h,
        tokens: tokensLast6h,
        // `cost_microcents` remains routing-only for compatible analytics;
        // customer-facing burn uses the explicit billed fields below.
        cost_microcents: routingCostLast6h,
        billed_cost_microcents: billedCostLast6h,
        unknown_cost_requests: toNumber(burn.unknown_cost_requests),
        actual_costs_qualified: toNumber(burn.unknown_cost_requests) === 0,
        // Projected fields are estimates extrapolated from the recent window
        // above (window-rate * 24/windowHours for daily, * days-in-month for
        // monthly). They are 0 when the window has too little data to trust.
        projection_is_estimate: true,
        projection_basis_requests: requestsLast6h,
        projected_daily_tokens: projectedDailyTokens,
        projected_daily_cost_microcents: projectedDailyRoutingCostMicrocents,
        projected_monthly_cost_microcents: projectedMonthlyRoutingCostMicrocents,
        projected_daily_billed_cost_microcents: projectedDailyBilledCostMicrocents,
        projected_monthly_billed_cost_microcents: projectedMonthlyBilledCostMicrocents,
      },
      daily: daily.rows.map((r) => ({
        day: r.day,
        requests: toNumber(r.requests),
        input_tokens: toNumber(r.input_tokens),
        output_tokens: toNumber(r.output_tokens),
        total_tokens: toNumber(r.total_tokens),
        system_prompt_tokens: toNumber(r.system_prompt_tokens),
        cost_microcents: toNumber(r.cost_microcents),
        billed_cost_microcents: toNumber(r.billed_cost_microcents),
        cache_hits: toNumber(r.cache_hits),
        unknown_cost_requests: toNumber(r.unknown_cost_requests),
        actual_costs_qualified: toNumber(r.unknown_cost_requests) === 0,
      })),
      hourly: hourly.rows.map((r) => ({
        hour: r.hour,
        requests: toNumber(r.requests),
        input_tokens: toNumber(r.input_tokens),
        output_tokens: toNumber(r.output_tokens),
        total_tokens: toNumber(r.total_tokens),
        cost_microcents: toNumber(r.cost_microcents),
        billed_cost_microcents: toNumber(r.billed_cost_microcents),
        unknown_cost_requests: toNumber(r.unknown_cost_requests),
        actual_costs_qualified: toNumber(r.unknown_cost_requests) === 0,
      })),
      heatmap: heatmap.rows.map((r) => ({
        weekday: toNumber(r.weekday),
        hour: toNumber(r.hour),
        requests: toNumber(r.requests),
        total_tokens: toNumber(r.total_tokens),
        cost_microcents: toNumber(r.cost_microcents),
        billed_cost_microcents: toNumber(r.billed_cost_microcents),
        unknown_cost_requests: toNumber(r.unknown_cost_requests),
        actual_costs_qualified: toNumber(r.unknown_cost_requests) === 0,
      })),
      models: models.rows.map((r) => ({
        model: r.model,
        requests: toNumber(r.requests),
        input_tokens: toNumber(r.input_tokens),
        output_tokens: toNumber(r.output_tokens),
        total_tokens: toNumber(r.total_tokens),
        system_prompt_tokens: toNumber(r.system_prompt_tokens),
        cost_microcents: toNumber(r.cost_microcents),
        billed_cost_microcents: toNumber(r.billed_cost_microcents),
        avg_latency_ms: toNumber(r.avg_latency_ms),
        cache_hits: toNumber(r.cache_hits),
        unknown_cost_requests: toNumber(r.unknown_cost_requests),
        actual_costs_qualified: toNumber(r.unknown_cost_requests) === 0,
      })),
      providers: providers.rows.map((r) => ({
        provider: r.provider,
        requests: toNumber(r.requests),
        input_tokens: toNumber(r.input_tokens),
        output_tokens: toNumber(r.output_tokens),
        total_tokens: toNumber(r.total_tokens),
        cost_microcents: toNumber(r.cost_microcents),
        billed_cost_microcents: toNumber(r.billed_cost_microcents),
        avg_latency_ms: toNumber(r.avg_latency_ms),
        errors: toNumber(r.errors),
        unknown_cost_requests: toNumber(r.unknown_cost_requests),
        actual_costs_qualified: toNumber(r.unknown_cost_requests) === 0,
      })),
      expensive_requests: expensiveRequests.rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        provider: r.provider,
        model: r.model,
        input_tokens: toNumber(r.input_tokens),
        output_tokens: toNumber(r.output_tokens),
        total_tokens: toNumber(r.total_tokens),
        system_prompt_tokens: toNumber(r.system_prompt_tokens),
        cost_microcents: toNumber(r.actual_cost_microcents),
        actual_cost_known: r.actual_cost_known === true || r.actual_cost_known === 1,
        plugin_cost_microcents: toNumber(r.plugin_cost_microcents),
        billed_cost_microcents: toNumber(r.billed_cost_microcents),
        total_latency_ms: toNumber(r.total_latency_ms),
        cache_hit: Boolean(r.cache_hit),
        status_code: toNumber(r.status_code),
      })),
    });
  } catch (err) {
    console.error('Token tracker error:', err);
    return NextResponse.json({ error: 'Failed to load token tracker data' }, { status: 500 });
  }
}
