import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';

interface ClickHouseMonthlyRow {
  user_id: string;
  original_model: string;
  routed_model: string;
  total_input_tokens: number;
  total_output_tokens: number;
  /** Provider/routing cost only; never includes a RouteShift plugin fee. */
  actual_cost_microcents: number;
  /** Separately measured plugin surcharge for the grouped requests. */
  plugin_cost_microcents: number;
  /** Customer-billed request cost: actual provider cost plus plugin surcharge. */
  billed_cost_microcents: number;
  request_count: number;
  /** Requests whose provider cost is only a lower bound. */
  unknown_cost_requests: number;
  /** False when any grouped request still has unresolved provider cost. */
  actual_costs_qualified: boolean;
}

interface MonthlyUsageRecord extends ClickHouseMonthlyRow {
  user_email: string | null;
}

export function parseUsageMonth(value: string | null): { month: string; start: Date; end: Date } | null {
  if (!value) return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));

  return { month: value, start, end };
}

export async function handleMonthlyUsage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const parsed = parseUsageMonth(url.searchParams.get('month'));
  if (!parsed) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'month query parameter must be in YYYY-MM format' } }));
    return;
  }

  if (!config.clickhouseUrl) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'CLICKHOUSE_URL is not configured' } }));
    return;
  }

  const baseRecords = await queryMonthlyUsageFromClickHouse(config.clickhouseUrl, parsed.start, parsed.end);
  const userEmailsById = await getUserEmailMap(baseRecords.map((r) => r.user_id));

  const records: MonthlyUsageRecord[] = baseRecords.map((record) => ({
    ...record,
    user_email: userEmailsById.get(record.user_id) ?? null,
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ month: parsed.month, records }));
}

async function queryMonthlyUsageFromClickHouse(
  clickhouseUrl: string,
  start: Date,
  end: Date,
): Promise<ClickHouseMonthlyRow[]> {
  const startIso = start.toISOString().replace('T', ' ').slice(0, 19);
  const endIso = end.toISOString().replace('T', ' ').slice(0, 19);
  // Query the raw request_logs table directly. The savings_hourly rollup only
  // carries (hour, team_id) with AggregateFunction state columns — it has no
  // model dimensions or per-input/output token splits — so the previous query
  // referenced columns that don't exist and errored against real ClickHouse.
  // request_logs is partitioned by toYYYYMM(timestamp), so a single-month range
  // is partition-pruned. start/end are server-derived from a validated YYYY-MM
  // value (parseUsageMonth), never raw user input, so interpolation is safe.
  const query = [
    'SELECT',
    '  team_id AS user_id,',
    '  model_requested AS original_model,',
    '  model_resolved AS routed_model,',
    '  sum(input_tokens) AS total_input_tokens,',
    '  sum(output_tokens) AS total_output_tokens,',
    // Keep provider/routing cost visible independently. Any caller that means
    // customer spend must use the explicit billed total below.
    '  sum(actual_cost_microcents) AS actual_cost_microcents,',
    '  sum(COALESCE(plugin_cost_microcents, 0)) AS plugin_cost_microcents,',
    '  sum(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)) AS billed_cost_microcents,',
    '  count() AS request_count,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    `WHERE timestamp >= toDateTime64('${startIso}', 3, 'UTC')`,
    `  AND timestamp < toDateTime64('${endIso}', 3, 'UTC')`,
    'GROUP BY user_id, original_model, routed_model',
    'ORDER BY user_id ASC, original_model ASC, routed_model ASC',
    'FORMAT JSONEachRow',
  ].join('\n');

  const response = await fetch(`${clickhouseUrl}/?query=${encodeURIComponent(query)}`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`ClickHouse monthly usage query failed with status ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim()) return [];

  const rows = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  return rows.map((row) => {
    const unknownCostRequests = Number(row.unknown_cost_requests ?? 0);
    return {
      user_id: String(row.user_id ?? ''),
      original_model: String(row.original_model ?? ''),
      routed_model: String(row.routed_model ?? ''),
      total_input_tokens: Number(row.total_input_tokens ?? 0),
      total_output_tokens: Number(row.total_output_tokens ?? 0),
      actual_cost_microcents: Number(row.actual_cost_microcents ?? 0),
      plugin_cost_microcents: Number(row.plugin_cost_microcents ?? 0),
      billed_cost_microcents: Number(row.billed_cost_microcents ?? 0),
      request_count: Number(row.request_count ?? 0),
      unknown_cost_requests: unknownCostRequests,
      actual_costs_qualified: unknownCostRequests === 0,
    };
  });
}

async function getUserEmailMap(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  if (!config.databaseUrl) return new Map();

  const pool = getPool();
  const { rows } = await pool.query<{ user_id: string; user_email: string }>(
    `SELECT DISTINCT ON (tm.team_id)
      tm.team_id AS user_id,
      u.email AS user_email
     FROM team_members tm
     JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ANY($1)
     ORDER BY tm.team_id,
       CASE WHEN tm.role = 'owner' THEN 0 ELSE 1 END,
       tm.joined_at ASC`,
    [userIds],
  );

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.user_id, row.user_email);
  }
  return map;
}
