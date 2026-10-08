// LAY-333: per-tag spend breakdown for /billing.
//
// Same data as /by-key, rolled up on `api_keys.metadata->>'<tag>'` so
// admins can answer "which customer cost us the most this month?" once
// they tag keys with `customer_id` (or any other dimension).
//
// Query params:
//   key:    metadata jsonb key to group on (required)
//   period: 24h | 7d | 30d | mtd (default mtd)
//
// Also returns `available_keys` — distinct metadata top-level keys with
// non-null values, so the dashboard can populate the dropdown without a
// second round-trip. Empty-state friendly: when no keys have tags set,
// `rows` is empty and `available_keys` is `[]`.

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

function periodClause(period: string): { sql: string; param?: number } {
  // The by-tag aggregation binds $1=teamId and $2=tagKey (used as a TEXT operand
  // in `metadata->>$2` / `metadata ? $2`), so the period's hours value is the
  // THIRD positional param ($3) here — unlike by-key, where $2 is the hours
  // value. Referencing $2 below collided with the tag key: `make_interval(hours
  // => $2)` typed $2 as the tag text, failing the function-signature match and
  // 500-ing every non-mtd period (the hours pushed as $3 went unreferenced).
  if (period === '24h') return { sql: 'timestamp >= NOW() - make_interval(hours => $3)', param: 24 };
  if (period === '7d') return { sql: 'timestamp >= NOW() - make_interval(hours => $3)', param: 168 };
  if (period === '30d') return { sql: 'timestamp >= NOW() - make_interval(hours => $3)', param: 720 };
  return { sql: "timestamp >= date_trunc('month', NOW())" };
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
    const tagKey = searchParams.get('key');
    const period = searchParams.get('period') ?? 'mtd';
    const clause = periodClause(period);

    const pool = getPool();

    // Available tag keys: distinct top-level keys across metadata for this team.
    // Skip the heavy aggregation when the dashboard is just populating the dropdown.
    const availableKeysRes = await pool.query(
      `
      SELECT DISTINCT jsonb_object_keys(metadata) AS k
      FROM api_keys
      WHERE team_id = $1
        AND revoked_at IS NULL
        AND metadata IS NOT NULL
        AND metadata <> '{}'::jsonb
      ORDER BY k
      `,
      [teamId],
    );
    const available_keys = availableKeysRes.rows.map((r) => r.k as string);

    if (!tagKey) {
      return NextResponse.json({ period, key: null, rows: [], available_keys });
    }

    const params: unknown[] = [teamId, tagKey];
    if (clause.param !== undefined) params.push(clause.param);

    const { rows } = await pool.query(
      `
      SELECT
        ak.metadata->>$2 AS tag_value,
        COUNT(DISTINCT rl.api_key_id)::int AS keys,
        COUNT(*)::int AS requests,
        COALESCE(SUM(rl.input_tokens), 0)::bigint AS input_tokens,
        COALESCE(SUM(rl.output_tokens), 0)::bigint AS output_tokens,
        -- Tag attribution is billed spend: routing actual cost plus plugin
        -- charges. Routing savings remain a separate routing-only metric.
        COALESCE(SUM(rl.actual_cost_microcents + COALESCE(rl.plugin_cost_microcents, 0)), 0)::bigint AS cost_microcents,
        COUNT(*) FILTER (WHERE rl.actual_cost_known = false)::int AS unknown_cost_requests
      FROM request_logs rl
      JOIN api_keys ak ON ak.id = rl.api_key_id
      WHERE rl.team_id = $1
        AND ak.metadata ? $2
        AND ${clause.sql}
        AND COALESCE(rl.cache_hit, false) = false
      GROUP BY tag_value
      ORDER BY cost_microcents DESC
      `,
      params,
    );

    const result = rows.map((r) => ({
      tag_value: (r.tag_value as string | null) ?? '(empty)',
      keys: Number(r.keys),
      requests: Number(r.requests),
      input_tokens: Number(r.input_tokens),
      output_tokens: Number(r.output_tokens),
      cost_microcents: Number(r.cost_microcents),
      unknown_cost_requests: Number(r.unknown_cost_requests ?? 0),
      actual_costs_qualified: Number(r.unknown_cost_requests ?? 0) === 0,
    }));

    const total_cost_microcents = result.reduce((s, r) => s + r.cost_microcents, 0);

    return NextResponse.json({
      period,
      key: tagKey,
      rows: result,
      total_cost_microcents,
      unknown_cost_requests: result.reduce((s, r) => s + r.unknown_cost_requests, 0),
      actual_costs_qualified: result.every((r) => r.actual_costs_qualified),
      available_keys,
    });
  } catch (err) {
    console.error('billing/by-tag endpoint error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
