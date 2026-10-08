import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../db/pool.js';

// Read endpoint for the Optimize surface. Exposes the optimize_findings rows
// (produced nightly by apps/proxy/src/optimize/engine.ts) to Axiom Layer so
// it can render ranked, copy-paste-fixable waste findings. Same auth +
// team_id convention as /admin/usage/*. Costs are returned in RouteShift
// scale (1 USD = 100,000,000 microcents); Layer converts on ingest.

interface OptimizeFindingRow {
  id:                           string;
  rule_id:                      string;
  severity:                     'high' | 'medium' | 'low';
  estimated_savings_microcents: string; // bigint -> string from pg
  body_md:                      string;
  fix_md:                       string;
  status:                       'open' | 'resolved' | 'dismissed';
  first_seen_at:                string;
  last_seen_at:                 string;
}

export async function handleOptimizeFindings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }

  const includeAll = url.searchParams.get('status') === 'all';

  const pool = getPool();
  const { rows } = await pool.query<OptimizeFindingRow>(
    `SELECT id, rule_id, severity,
            f.estimated_savings_microcents::text AS estimated_savings_microcents,
            body_md, fix_md, status, first_seen_at, last_seen_at
      FROM optimize_findings f
      WHERE f.team_id = $1
        ${includeAll ? '' : "AND f.status = 'open'"}
      ORDER BY CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
               f.estimated_savings_microcents DESC`,
    [teamId],
  );

  const findings = rows.map((r) => ({
    id:                           r.id,
    rule_id:                      r.rule_id,
    severity:                     r.severity,
    estimated_savings_microcents: Number(r.estimated_savings_microcents),
    body_md:                      r.body_md,
    fix_md:                       r.fix_md,
    status:                       r.status,
    first_seen_at:                r.first_seen_at,
    last_seen_at:                 r.last_seen_at,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ team_id: teamId, findings }));
}
