import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { parseUsageMonth } from './monthly.js';
import { clickHouseQueryUrl } from './clickhouse.js';

// Monthly savings rollup. Used by Axiom Layer to show RouteShift routing
// savings without reaching into RouteShift's dashboard session-auth API.

interface SavingsRow {
  savings_microcents: string | number | null;
  unknown_cost_requests: string | number | null;
}

interface QualifiedSavings {
  savings_microcents: number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
}

export async function handleUsageSavings(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const savings = config.clickhouseUrl
    ? await querySavingsFromClickHouse(config.clickhouseUrl, teamId, parsed.start, parsed.end)
    : await querySavingsFromPostgres(teamId, parsed.start, parsed.end);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    month: parsed.month,
    team_id: teamId,
    ...savings,
  }));
}

function toQualifiedSavings(row: SavingsRow | undefined): QualifiedSavings {
  const parsedSavings = Number(row?.savings_microcents ?? 0);
  const unknownCostRequests = Number(row?.unknown_cost_requests ?? 0);
  return {
    savings_microcents: Number.isFinite(parsedSavings) ? parsedSavings : 0,
    unknown_cost_requests: unknownCostRequests,
    actual_costs_qualified: unknownCostRequests === 0,
  };
}

async function querySavingsFromPostgres(teamId: string, start: Date, end: Date): Promise<QualifiedSavings> {
  const pool = getPool();
  const { rows } = await pool.query<SavingsRow>(
    `SELECT
       COALESCE(SUM(GREATEST(savings_microcents, 0))
         FILTER (WHERE actual_cost_known = true), 0)::bigint AS savings_microcents,
       COUNT(*) FILTER (WHERE actual_cost_known = false)::bigint AS unknown_cost_requests
     FROM request_logs
     WHERE team_id = $1
       AND timestamp >= $2
       AND timestamp < $3`,
    [teamId, start.toISOString(), end.toISOString()],
  );
  return toQualifiedSavings(rows[0]);
}

async function querySavingsFromClickHouse(
  clickhouseUrl: string,
  teamId: string,
  start: Date,
  end: Date,
): Promise<QualifiedSavings> {
  const startIso = start.toISOString().replace('T', ' ').slice(0, 19);
  const endIso = end.toISOString().replace('T', ' ').slice(0, 19);
  const query = [
    'SELECT',
    '  COALESCE(sum(if(actual_cost_known = 1 AND savings_microcents > 0, savings_microcents, 0)), 0) AS savings_microcents,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    'WHERE team_id = {team_id:String}',
    "  AND timestamp >= toDateTime64({start:String}, 3, 'UTC')",
    "  AND timestamp < toDateTime64({end:String}, 3, 'UTC')",
    'FORMAT JSONEachRow',
  ].join('\n');

  const response = await fetch(clickHouseQueryUrl(clickhouseUrl, query, { team_id: teamId, start: startIso, end: endIso }), {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`ClickHouse savings query failed with status ${response.status}`);
  }
  const text = await response.text();
  if (!text.trim()) return toQualifiedSavings(undefined);
  const row = JSON.parse(text.trim().split('\n')[0] ?? '{}') as SavingsRow;
  return toQualifiedSavings(row);
}
