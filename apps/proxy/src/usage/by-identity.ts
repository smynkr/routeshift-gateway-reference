import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../db/pool.js';
import { parseUsageMonth } from './monthly.js';

// Per-identity rollup. Used by Axiom Layer to surface per-employee LLM spend
// without ClickHouse access — Postgres handles a single tenant's monthly
// rollup just fine at the volumes Layer cares about.

interface IdentityRow {
  identity_id:            string;
  total_input_tokens:     number;
  total_output_tokens:    number;
  /** Provider/routing cost only. */
  actual_cost_microcents: number;
  /** Measured plugin surcharge, distinct from routing cost/savings. */
  plugin_cost_microcents: number;
  /** Customer-billed cost: actual provider cost plus plugin surcharge. */
  billed_cost_microcents: number;
  /** Auto-router win, floored at zero (see query comment for the LAY-345 rationale). */
  savings_microcents:     number;
  request_count:          number;
  unknown_cost_requests:  number;
}

export async function handleUsageByIdentity(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }

  const parsed = parseUsageMonth(url.searchParams.get('month'));
  if (!parsed) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'month query parameter must be in YYYY-MM format' } }));
    return;
  }

  const pool = getPool();
  const { rows } = await pool.query<IdentityRow>(
    `SELECT
       -- AXI-8: the logged snapshot is the attribution of record. The writer
       -- stores '' for key-without-identity requests (ClickHouse convention),
       -- so the snapshot arm must NOT go through NULLIF: '' is "known
       -- unattributed" and must never fall back. Only a genuine NULL —
       -- which can only be a pre-migration row — may fall back to current
       -- key metadata, which keeps that legacy window bounded structurally.
       COALESCE(l.layer_identity_id, k.metadata->>'layer_identity_id') AS identity_id,
       sum(l.input_tokens)::bigint        AS total_input_tokens,
       sum(l.output_tokens)::bigint       AS total_output_tokens,
       sum(l.actual_cost_microcents)::bigint AS actual_cost_microcents,
       sum(COALESCE(l.plugin_cost_microcents, 0))::bigint AS plugin_cost_microcents,
       sum(l.actual_cost_microcents + COALESCE(l.plugin_cost_microcents, 0))::bigint AS billed_cost_microcents,
       -- LAY-345: per-request savings_microcents can go negative (a fallback
       -- to a costlier model — see cost/calculator.ts). Every other savings
       -- aggregation in this repo floors each row at zero before summing so
       -- a person's "savings" here can never render negative; match that
       -- convention rather than the raw sum(l.savings_microcents) the ticket
       -- proposed.
       COALESCE(sum(GREATEST(l.savings_microcents, 0))
         FILTER (WHERE l.actual_cost_known = true), 0)::bigint AS savings_microcents,
       count(*)::bigint                    AS request_count,
       count(*) FILTER (WHERE l.actual_cost_known = false)::bigint AS unknown_cost_requests
     FROM request_logs l
     -- LEFT JOIN: a snapshotted row must surface even when it carries no
     -- api_key_id (or the key row is gone) — the join only feeds the legacy
     -- metadata fallback below. k.team_id pinned to l.team_id so a stale or
     -- corrupt api_key_id can never borrow another tenant's identity label.
     LEFT JOIN api_keys k ON k.id = l.api_key_id AND k.team_id = l.team_id
     WHERE l.team_id = $1
       AND l.timestamp >= $2
       AND l.timestamp < $3
       AND (
         NULLIF(l.layer_identity_id, '') IS NOT NULL
         OR (l.layer_identity_id IS NULL AND NULLIF(k.metadata->>'layer_identity_id', '') IS NOT NULL)
       )
     GROUP BY COALESCE(l.layer_identity_id, k.metadata->>'layer_identity_id')
     ORDER BY billed_cost_microcents DESC`,
    [teamId, parsed.start.toISOString(), parsed.end.toISOString()],
  );

  const records = rows.map((row) => {
    const unknownCostRequests = Number(row.unknown_cost_requests ?? 0);
    return {
      ...row,
      unknown_cost_requests: unknownCostRequests,
      actual_costs_qualified: unknownCostRequests === 0,
    };
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ month: parsed.month, team_id: teamId, records }));
}
