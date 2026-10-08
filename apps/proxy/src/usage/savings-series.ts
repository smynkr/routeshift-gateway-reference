import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { clickHouseQueryUrl } from './clickhouse.js';
import { parseUsageMonth } from './monthly.js';

// Daily savings-over-time series for one team within a month. Backs Axiom
// Layer's AI Usage "Savings" tab. Mirrors usage/savings.ts: team-scoped,
// branches on CLICKHOUSE_URL, queries raw request_logs in both backends.
// `actual_microcents` and `savings_microcents` keep their routing/provider
// meaning. `billed_microcents` is separately exposed for customer spend and
// includes measured plugin fees.

const DEMO_TEAM_ID = 'd0000000-0000-4000-8000-000000000001';

interface SavingsSeriesRow {
  day:                 string;
  original_microcents: string | number | null;
  actual_microcents:   string | number | null;
  plugin_microcents:   string | number | null;
  billed_microcents:   string | number | null;
  savings_microcents:  string | number | null;
  requests:            string | number | null;
  unknown_cost_requests: string | number | null;
}

interface SavingsSeriesPoint {
  day:                 string;
  original_microcents: number;
  actual_microcents:   number;
  plugin_microcents:   number;
  billed_microcents:   number;
  savings_microcents:  number;
  requests:            number;
  unknown_cost_requests: number;
  actual_costs_qualified: boolean;
}

function toPoint(row: SavingsSeriesRow): SavingsSeriesPoint {
  const unknownCostRequests = Number(row.unknown_cost_requests ?? 0);
  return {
    day:                 row.day,
    original_microcents: Number(row.original_microcents ?? 0),
    actual_microcents:   Number(row.actual_microcents ?? 0),
    plugin_microcents:   Number(row.plugin_microcents ?? 0),
    billed_microcents:   Number(row.billed_microcents ?? 0),
    savings_microcents:  Number(row.savings_microcents ?? 0),
    requests:            Number(row.requests ?? 0),
    unknown_cost_requests: unknownCostRequests,
    actual_costs_qualified: unknownCostRequests === 0,
  };
}

export async function handleSavingsSeries(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const useClickHouse = Boolean(config.clickhouseUrl && teamId !== DEMO_TEAM_ID);
  const series = useClickHouse
    ? await queryFromClickHouse(config.clickhouseUrl!, teamId, parsed.start, parsed.end)
    : await queryFromPostgres(teamId, parsed.start, parsed.end);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    month: parsed.month,
    team_id: teamId,
    source: config.clickhouseUrl && teamId === DEMO_TEAM_ID ? 'postgres-demo' : useClickHouse ? 'clickhouse' : 'postgres',
    series,
  }));
}

async function queryFromPostgres(teamId: string, start: Date, end: Date): Promise<SavingsSeriesPoint[]> {
  const pool = getPool();
  const { rows } = await pool.query<SavingsSeriesRow>(
    `SELECT
       to_char(date_trunc('day', timestamp AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       COALESCE(SUM(original_cost_microcents), 0)::bigint                      AS original_microcents,
       COALESCE(SUM(actual_cost_microcents), 0)::bigint                        AS actual_microcents,
       COALESCE(SUM(COALESCE(plugin_cost_microcents, 0)), 0)::bigint            AS plugin_microcents,
       COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_microcents,
       COALESCE(SUM(GREATEST(savings_microcents, 0))
         FILTER (WHERE actual_cost_known = true), 0)::bigint                   AS savings_microcents,
       COUNT(*)::int                                                           AS requests,
       COUNT(*) FILTER (WHERE actual_cost_known = false)::int                  AS unknown_cost_requests
     FROM request_logs
     WHERE team_id = $1
       AND timestamp >= $2
       AND timestamp < $3
     GROUP BY 1
     ORDER BY 1`,
    [teamId, start.toISOString(), end.toISOString()],
  );
  return rows.map(toPoint);
}

async function queryFromClickHouse(
  clickhouseUrl: string,
  teamId: string,
  start: Date,
  end: Date,
): Promise<SavingsSeriesPoint[]> {
  const startIso = start.toISOString().replace('T', ' ').slice(0, 19);
  const endIso = end.toISOString().replace('T', ' ').slice(0, 19);
  const query = [
    'SELECT',
    "  toString(toDate(timestamp, 'UTC')) AS day,",
    '  COALESCE(sum(original_cost_microcents), 0) AS original_microcents,',
    '  COALESCE(sum(actual_cost_microcents), 0) AS actual_microcents,',
    '  COALESCE(sum(COALESCE(plugin_cost_microcents, 0)), 0) AS plugin_microcents,',
    '  COALESCE(sum(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0) AS billed_microcents,',
    '  COALESCE(sum(if(actual_cost_known = 1 AND savings_microcents > 0, savings_microcents, 0)), 0) AS savings_microcents,',
    '  count() AS requests,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    'WHERE team_id = {team_id:String}',
    "  AND timestamp >= toDateTime64({start:String}, 3, 'UTC')",
    "  AND timestamp < toDateTime64({end:String}, 3, 'UTC')",
    'GROUP BY day',
    'ORDER BY day',
    'FORMAT JSONEachRow',
  ].join('\n');

  const response = await fetch(
    clickHouseQueryUrl(clickhouseUrl, query, { team_id: teamId, start: startIso, end: endIso }),
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(`ClickHouse savings-series query failed with status ${response.status}`);
  }
  const text = await response.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => toPoint(JSON.parse(line) as SavingsSeriesRow));
}
