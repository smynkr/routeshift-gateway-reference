import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { clickHouseQueryUrl } from './clickhouse.js';
import { parseUsageMonth } from './monthly.js';

// Per-model, per-day token + cost breakdown for one team within a month. Backs
// Axiom Layer's AI Usage "Token Tracker" tab. Groups by model_resolved (the
// model that actually ran — the index-backed canonical dimension). Mirrors
// usage/savings.ts: team-scoped, branches on CLICKHOUSE_URL, queries raw
// request_logs in both backends. `actual_cost_microcents` remains provider/
// routing cost, while `billed_cost_microcents` explicitly includes any measured
// plugin fee. Cache-token columns exist only in ClickHouse and are intentionally
// omitted in v1 so the shape is uniform across both backends (0 on Postgres
// would be misleading).

const DEMO_TEAM_ID = 'd0000000-0000-4000-8000-000000000001';

interface ByModelDayRow {
  day:                    string;
  model:                  string;
  input_tokens:           string | number | null;
  output_tokens:          string | number | null;
  total_tokens:           string | number | null;
  actual_cost_microcents: string | number | null;
  plugin_cost_microcents: string | number | null;
  billed_cost_microcents: string | number | null;
  request_count:          string | number | null;
  unknown_cost_requests:  string | number | null;
}

interface ByModelDayRecord {
  day:                    string;
  model:                  string;
  input_tokens:           number;
  output_tokens:          number;
  total_tokens:           number;
  actual_cost_microcents: number;
  plugin_cost_microcents: number;
  billed_cost_microcents: number;
  request_count:          number;
  unknown_cost_requests:  number;
  actual_costs_qualified: boolean;
}

function toRecord(row: ByModelDayRow): ByModelDayRecord {
  const unknownCostRequests = Number(row.unknown_cost_requests ?? 0);
  return {
    day:                    row.day,
    model:                  row.model,
    input_tokens:           Number(row.input_tokens ?? 0),
    output_tokens:          Number(row.output_tokens ?? 0),
    total_tokens:           Number(row.total_tokens ?? 0),
    actual_cost_microcents: Number(row.actual_cost_microcents ?? 0),
    plugin_cost_microcents: Number(row.plugin_cost_microcents ?? 0),
    billed_cost_microcents: Number(row.billed_cost_microcents ?? 0),
    request_count:          Number(row.request_count ?? 0),
    unknown_cost_requests:  unknownCostRequests,
    actual_costs_qualified: unknownCostRequests === 0,
  };
}

export async function handleByModelDay(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const records = useClickHouse
    ? await queryFromClickHouse(config.clickhouseUrl!, teamId, parsed.start, parsed.end)
    : await queryFromPostgres(teamId, parsed.start, parsed.end);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    month: parsed.month,
    team_id: teamId,
    source: config.clickhouseUrl && teamId === DEMO_TEAM_ID ? 'postgres-demo' : useClickHouse ? 'clickhouse' : 'postgres',
    records,
  }));
}

async function queryFromPostgres(teamId: string, start: Date, end: Date): Promise<ByModelDayRecord[]> {
  const pool = getPool();
  const { rows } = await pool.query<ByModelDayRow>(
    `SELECT
       to_char(date_trunc('day', timestamp AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       model_resolved                                   AS model,
       COALESCE(SUM(input_tokens), 0)::bigint           AS input_tokens,
       COALESCE(SUM(output_tokens), 0)::bigint          AS output_tokens,
       COALESCE(SUM(total_tokens), 0)::bigint           AS total_tokens,
       COALESCE(SUM(actual_cost_microcents), 0)::bigint AS actual_cost_microcents,
       COALESCE(SUM(COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS plugin_cost_microcents,
       COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0)::bigint AS billed_cost_microcents,
       COUNT(*)::int                                    AS request_count,
       COUNT(*) FILTER (WHERE actual_cost_known = false)::int AS unknown_cost_requests
     FROM request_logs
     WHERE team_id = $1
       AND timestamp >= $2
       AND timestamp < $3
     GROUP BY 1, model_resolved
     ORDER BY day ASC, billed_cost_microcents DESC, model ASC`,
    [teamId, start.toISOString(), end.toISOString()],
  );
  return rows.map(toRecord);
}

async function queryFromClickHouse(
  clickhouseUrl: string,
  teamId: string,
  start: Date,
  end: Date,
): Promise<ByModelDayRecord[]> {
  const startIso = start.toISOString().replace('T', ' ').slice(0, 19);
  const endIso = end.toISOString().replace('T', ' ').slice(0, 19);
  const query = [
    'SELECT',
    "  toString(toDate(timestamp, 'UTC')) AS day,",
    '  model_resolved AS model,',
    '  COALESCE(sum(input_tokens), 0) AS input_tokens,',
    '  COALESCE(sum(output_tokens), 0) AS output_tokens,',
    '  COALESCE(sum(total_tokens), 0) AS total_tokens,',
    '  COALESCE(sum(actual_cost_microcents), 0) AS actual_cost_microcents,',
    '  COALESCE(sum(COALESCE(plugin_cost_microcents, 0)), 0) AS plugin_cost_microcents,',
    '  COALESCE(sum(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)), 0) AS billed_cost_microcents,',
    '  count() AS request_count,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    'WHERE team_id = {team_id:String}',
    "  AND timestamp >= toDateTime64({start:String}, 3, 'UTC')",
    "  AND timestamp < toDateTime64({end:String}, 3, 'UTC')",
    'GROUP BY day, model',
    'ORDER BY day ASC, billed_cost_microcents DESC, model ASC',
    'FORMAT JSONEachRow',
  ].join('\n');

  const response = await fetch(
    clickHouseQueryUrl(clickhouseUrl, query, { team_id: teamId, start: startIso, end: endIso }),
    { method: 'POST' },
  );
  if (!response.ok) {
    throw new Error(`ClickHouse by-model-day query failed with status ${response.status}`);
  }
  const text = await response.text();
  if (!text.trim()) return [];
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => toRecord(JSON.parse(line) as ByModelDayRow));
}
