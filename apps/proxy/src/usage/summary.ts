import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { validateApiKey } from '../auth/api-key.js';
import { keyHasReadScope } from '../auth/scope.js';
import { clickHouseQueryUrl } from './clickhouse.js';
import {
  resolveUsageRange,
  zeroFillSeries,
  buildContributions,
  type UsageRange,
  type SeriesPoint,
  type ContributionInput,
} from './summary-range.js';

const BY_MODEL_CAP = 50; // documented cap; top models by billed spend
const DAY_MS = 86_400_000;

interface SummaryAgg {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  spend_microcents: number;
  savings_microcents: number;
  /** Number of rows whose provider cost is a lower bound, not an exact amount. */
  unknown_cost_requests: number;
  /** True only when every request in the range has exact provider cost. */
  actual_costs_qualified: boolean;
}
interface ByModel {
  model: string; provider: string; requests: number;
  input_tokens: number; output_tokens: number;
  spend_microcents: number; savings_microcents: number;
  unknown_cost_requests: number; actual_costs_qualified: boolean;
}
interface ByKeyAgg {
  api_key_id: string; requests: number; spend_microcents: number; savings_microcents: number;
  unknown_cost_requests: number; actual_costs_qualified: boolean;
}

interface RawUsage {
  summary: SummaryAgg;
  by_model: ByModel[];
  by_key: ByKeyAgg[];
  series: SeriesPoint[];
  contributions: ContributionInput[];
}

const EMPTY_SUMMARY: SummaryAgg = {
  requests: 0, input_tokens: 0, output_tokens: 0,
  cache_read_tokens: 0, cache_write_tokens: 0, spend_microcents: 0, savings_microcents: 0,
  unknown_cost_requests: 0, actual_costs_qualified: true,
};

export async function handleUsageSummary(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // --- Auth: customer key, team resolved from the key (NEVER a param) ---
  const auth = req.headers['authorization'];
  const key = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!key || !key.startsWith('sk-proxy-')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'API key required' } }));
    return;
  }
  const info = await validateApiKey(key);
  if (!info) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    return;
  }
  const teamId = info.teamId;
  if (!keyHasReadScope(info.metadata)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'insufficient_scope: missing read scope', code: 'insufficient_scope' } }));
    return;
  }

  const url = new URL(req.url ?? '', 'http://localhost');
  // NOTE: any ?team_id= in the query string is intentionally ignored.
  const now = new Date();
  const rangeResult = resolveUsageRange(url.searchParams, now);
  if (!rangeResult.ok) {
    res.writeHead(rangeResult.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: rangeResult.message } }));
    return;
  }
  const range = rangeResult.range;

  let raw: RawUsage;
  if (config.clickhouseUrl) {
    try {
      raw = await queryClickHouse(config.clickhouseUrl, teamId, range, now);
    } catch {
      raw = await queryPostgres(teamId, range, now);
    }
  } else {
    raw = await queryPostgres(teamId, range, now);
  }

  const by_key = await enrichKeyPrefixes(raw.by_key);
  const credit_balance_microcents = await getCreditBalance(teamId);

  const series = zeroFillSeries(raw.series, range.since, range.until, range.bucket);
  const contributions = buildContributions(raw.contributions, range.contribDays, now);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    data: {
      range: { since: range.since.toISOString(), until: range.until.toISOString(), bucket: range.bucket },
      summary: { ...raw.summary, credit_balance_microcents },
      by_model: raw.by_model,
      by_key,
      series,
      contributions,
    },
  }));
}

// ----------------------------- ClickHouse -----------------------------

function chTimeBounds(range: UsageRange, now: Date): { start: string; end: string; contribStart: string; contribEnd: string } {
  const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
  const contribBounds = contributionBounds(range.contribDays, now);
  return {
    start: fmt(range.since),
    end: fmt(range.until),
    contribStart: fmt(contribBounds.start),
    contribEnd: fmt(contribBounds.end),
  };
}

async function queryClickHouse(clickhouseUrl: string, teamId: string, range: UsageRange, now: Date): Promise<RawUsage> {
  const b = chTimeBounds(range, now);
  const window = [
    'WHERE team_id = {team_id:String}',
    "  AND timestamp >= toDateTime64({start:String}, 3, 'UTC')",
    "  AND timestamp < toDateTime64({end:String}, 3, 'UTC')",
  ].join('\n');
  const baseParams = { team_id: teamId, start: b.start, end: b.end };

  const summaryQuery = [
    'SELECT',
    '  count() AS requests,',
    '  sum(input_tokens) AS input_tokens,',
    '  sum(output_tokens) AS output_tokens,',
    '  sum(cache_read_tokens) AS cache_read_tokens,',
    '  sum(cache_write_tokens) AS cache_write_tokens,',
    '  sum(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)) AS spend_microcents,',
    '  sum(if(actual_cost_known = 1 AND savings_microcents > 0, savings_microcents, 0)) AS savings_microcents,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    window,
    'FORMAT JSONEachRow',
  ].join('\n');

  const byModelQuery = [
    'SELECT',
    '  model_resolved AS model,',
    '  provider,',
    '  count() AS requests,',
    '  sum(input_tokens) AS input_tokens,',
    '  sum(output_tokens) AS output_tokens,',
    '  sum(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)) AS spend_microcents,',
    '  sum(if(actual_cost_known = 1 AND savings_microcents > 0, savings_microcents, 0)) AS savings_microcents,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    window,
    'GROUP BY model, provider',
    'ORDER BY spend_microcents DESC',
    `LIMIT ${BY_MODEL_CAP}`,
    'FORMAT JSONEachRow',
  ].join('\n');

  const byKeyQuery = [
    'SELECT',
    '  api_key_id,',
    '  count() AS requests,',
    '  sum(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)) AS spend_microcents,',
    '  sum(if(actual_cost_known = 1 AND savings_microcents > 0, savings_microcents, 0)) AS savings_microcents,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    window,
    'GROUP BY api_key_id',
    'ORDER BY spend_microcents DESC',
    `LIMIT ${BY_MODEL_CAP}`,
    'FORMAT JSONEachRow',
  ].join('\n');

  const bucketFn = range.bucket === 'hour' ? 'toStartOfHour' : 'toStartOfDay';
  const seriesQuery = [
    'SELECT',
    `  formatDateTime(${bucketFn}(timestamp), '%Y-%m-%dT%H:%M:%S.000Z', 'UTC') AS bucket_start,`,
    '  sum(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)) AS spend_microcents,',
    '  sum(input_tokens) AS input_tokens,',
    '  sum(output_tokens) AS output_tokens,',
    '  count() AS requests,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    window,
    'GROUP BY bucket_start',
    'ORDER BY bucket_start ASC',
    'FORMAT JSONEachRow',
  ].join('\n');

  const contribQuery = [
    'SELECT',
    "  formatDateTime(toDate(timestamp), '%Y-%m-%d', 'UTC') AS date,",
    '  sum(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)) AS spend_microcents,',
    '  sum(input_tokens + output_tokens) AS tokens,',
    '  countIf(actual_cost_known = 0) AS unknown_cost_requests',
    'FROM request_logs',
    'WHERE team_id = {team_id:String}',
    "  AND timestamp >= toDateTime64({contrib_start:String}, 3, 'UTC')",
    "  AND timestamp < toDateTime64({contrib_end:String}, 3, 'UTC')",
    'GROUP BY date',
    'ORDER BY date ASC',
    'FORMAT JSONEachRow',
  ].join('\n');

  // Sequential so the test can map responses to queries deterministically; the
  // queries are small aggregates and this is a low-QPS endpoint. chRows returns
  // untyped rows; the normalizers (which take Record<string, unknown>) impose shape.
  const summaryRows = await chRows(clickhouseUrl, summaryQuery, baseParams);
  const by_model = (await chRows(clickhouseUrl, byModelQuery, baseParams)).map(normalizeByModel);
  const by_key = (await chRows(clickhouseUrl, byKeyQuery, baseParams)).map(normalizeByKey);
  const series = (await chRows(clickhouseUrl, seriesQuery, baseParams)).map(normalizeSeries);
  const contributions = (await chRows(
    clickhouseUrl,
    contribQuery,
    { team_id: teamId, contrib_start: b.contribStart, contrib_end: b.contribEnd },
  )).map(normalizeContribution);

  return { summary: normalizeSummary(summaryRows[0]), by_model, by_key, series, contributions };
}

async function chRows(clickhouseUrl: string, query: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
  const response = await fetch(clickHouseQueryUrl(clickhouseUrl, query, params), { method: 'POST' });
  if (!response.ok) {
    throw new Error(`ClickHouse usage query failed with status ${response.status}`);
  }
  const text = await response.text();
  if (!text.trim()) return [];
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ----------------------------- Postgres fallback -----------------------------
// Dev / no-ClickHouse mode. Postgres request_logs has cache_read_tokens /
// cache_write_tokens columns. spend == actual cost.

async function queryPostgres(teamId: string, range: UsageRange, now: Date): Promise<RawUsage> {
  if (!config.databaseUrl) {
    return { summary: { ...EMPTY_SUMMARY }, by_model: [], by_key: [], series: [], contributions: [] };
  }
  const pool = getPool();
  const since = range.since.toISOString();
  const until = range.until.toISOString();

  const summary = await pool.query<Record<string, string>>(
    `SELECT COUNT(*)::bigint AS requests,
            COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COALESCE(SUM(cache_read_tokens),0)::bigint AS cache_read_tokens,
            COALESCE(SUM(cache_write_tokens),0)::bigint AS cache_write_tokens,
            COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)),0)::bigint AS spend_microcents,
            COALESCE(SUM(GREATEST(savings_microcents,0)) FILTER (WHERE actual_cost_known = true),0)::bigint AS savings_microcents,
            COUNT(*) FILTER (WHERE actual_cost_known = false)::bigint AS unknown_cost_requests
       FROM request_logs
      WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3`,
    [teamId, since, until],
  );

  const byModel = await pool.query<Record<string, string>>(
    `SELECT model_resolved AS model, provider,
            COUNT(*)::bigint AS requests,
            COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)),0)::bigint AS spend_microcents,
            COALESCE(SUM(GREATEST(savings_microcents,0)) FILTER (WHERE actual_cost_known = true),0)::bigint AS savings_microcents,
            COUNT(*) FILTER (WHERE actual_cost_known = false)::bigint AS unknown_cost_requests
       FROM request_logs
      WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY model_resolved, provider
      ORDER BY spend_microcents DESC
      LIMIT ${BY_MODEL_CAP}`,
    [teamId, since, until],
  );

  const byKey = await pool.query<Record<string, string>>(
    `SELECT api_key_id,
            COUNT(*)::bigint AS requests,
            COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)),0)::bigint AS spend_microcents,
            COALESCE(SUM(GREATEST(savings_microcents,0)) FILTER (WHERE actual_cost_known = true),0)::bigint AS savings_microcents,
            COUNT(*) FILTER (WHERE actual_cost_known = false)::bigint AS unknown_cost_requests
       FROM request_logs
      WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3 AND api_key_id IS NOT NULL
      GROUP BY api_key_id
      ORDER BY spend_microcents DESC
      LIMIT ${BY_MODEL_CAP}`,
    [teamId, since, until],
  );

  const bucketExpr = range.bucket === 'hour' ? "date_trunc('hour', timestamp)" : "date_trunc('day', timestamp)";
  const series = await pool.query<Record<string, string>>(
    `SELECT to_char(${bucketExpr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"') AS bucket_start,
            COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)),0)::bigint AS spend_microcents,
            COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
            COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COUNT(*)::bigint AS requests,
            COUNT(*) FILTER (WHERE actual_cost_known = false)::bigint AS unknown_cost_requests
       FROM request_logs
      WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY bucket_start
      ORDER BY bucket_start ASC`,
    [teamId, since, until],
  );

  const contribBounds = contributionBounds(range.contribDays, now);
  const contrib = await pool.query<Record<string, string>>(
    `SELECT to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
            COALESCE(SUM(actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)),0)::bigint AS spend_microcents,
            COALESCE(SUM(input_tokens + output_tokens),0)::bigint AS tokens,
            COUNT(*) FILTER (WHERE actual_cost_known = false)::bigint AS unknown_cost_requests
       FROM request_logs
      WHERE team_id = $1 AND timestamp >= $2 AND timestamp < $3
      GROUP BY date
      ORDER BY date ASC`,
    [teamId, contribBounds.start.toISOString(), contribBounds.end.toISOString()],
  );

  return {
    summary: normalizeSummary(summary.rows[0]),
    by_model: byModel.rows.map(normalizeByModel),
    by_key: byKey.rows.map(normalizeByKey),
    series: series.rows.map(normalizeSeries),
    contributions: contrib.rows.map(normalizeContribution),
  };
}

function contributionBounds(contribDays: number, now: Date): { start: Date; end: Date } {
  const today = startOfUtcDay(now);
  return {
    start: new Date(today.getTime() - (contribDays - 1) * DAY_MS),
    end: new Date(today.getTime() + DAY_MS),
  };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// ----------------------------- Enrichment (Postgres) -----------------------------

async function enrichKeyPrefixes(rows: ByKeyAgg[]): Promise<Array<ByKeyAgg & { key_prefix: string }>> {
  if (rows.length === 0 || !config.databaseUrl) {
    return rows.map((r) => ({ ...r, key_prefix: r.api_key_id }));
  }
  const ids = rows.map((r) => r.api_key_id).filter(Boolean);
  const prefixById = new Map<string, string>();
  if (ids.length > 0) {
    const { rows: keyRows } = await getPool().query<{ id: string; key_prefix: string }>(
      `SELECT id, key_prefix FROM api_keys WHERE id = ANY($1)`,
      [ids],
    );
    for (const k of keyRows) prefixById.set(k.id, k.key_prefix);
  }
  return rows.map((r) => ({ ...r, key_prefix: prefixById.get(r.api_key_id) ?? r.api_key_id }));
}

async function getCreditBalance(teamId: string): Promise<number | null> {
  if (!config.databaseUrl) return null;
  const { rows } = await getPool().query<{ balance_microcents: string }>(
    `SELECT balance_microcents FROM credit_balances WHERE team_id = $1`,
    [teamId],
  );
  return rows[0] ? Number(rows[0].balance_microcents) : null;
}

// ----------------------------- normalizers -----------------------------

function num(v: unknown): number { return Number(v ?? 0) || 0; }

function normalizeSummary(row: Partial<SummaryAgg> | Record<string, unknown> | undefined): SummaryAgg {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    requests: num(r.requests), input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens),
    cache_read_tokens: num(r.cache_read_tokens), cache_write_tokens: num(r.cache_write_tokens),
    spend_microcents: num(r.spend_microcents), savings_microcents: num(r.savings_microcents),
    unknown_cost_requests: num(r.unknown_cost_requests), actual_costs_qualified: num(r.unknown_cost_requests) === 0,
  };
}
function normalizeByModel(r: Record<string, unknown>): ByModel {
  return {
    model: String(r.model ?? ''), provider: String(r.provider ?? ''), requests: num(r.requests),
    input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens),
    spend_microcents: num(r.spend_microcents), savings_microcents: num(r.savings_microcents),
    unknown_cost_requests: num(r.unknown_cost_requests), actual_costs_qualified: num(r.unknown_cost_requests) === 0,
  };
}
function normalizeByKey(r: Record<string, unknown>): ByKeyAgg {
  return {
    api_key_id: String(r.api_key_id ?? ''), requests: num(r.requests),
    spend_microcents: num(r.spend_microcents), savings_microcents: num(r.savings_microcents),
    unknown_cost_requests: num(r.unknown_cost_requests), actual_costs_qualified: num(r.unknown_cost_requests) === 0,
  };
}
function normalizeSeries(r: Record<string, unknown>): SeriesPoint {
  return {
    bucket_start: String(r.bucket_start ?? ''), spend_microcents: num(r.spend_microcents),
    input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens), requests: num(r.requests),
    unknown_cost_requests: num(r.unknown_cost_requests), actual_costs_qualified: num(r.unknown_cost_requests) === 0,
  };
}
function normalizeContribution(r: Record<string, unknown>): ContributionInput {
  return {
    date: String(r.date ?? ''), spend_microcents: num(r.spend_microcents), tokens: num(r.tokens),
    unknown_cost_requests: num(r.unknown_cost_requests), actual_costs_qualified: num(r.unknown_cost_requests) === 0,
  };
}
