import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { clickHouseQueryUrl } from './clickhouse.js';
import { parseUsageMonth } from './monthly.js';

export type TokenHygieneReasonCode =
  | 'excessive_context_500k'
  | 'large_context_share_128k'
  | 'high_average_context'
  | 'oversized_system_prompt'
  | 'duplicate_requests'
  | 'low_cache_hit_on_repeated_work'
  | 'high_error_rate'
  | 'requests_exceed_1m_context';

export interface TokenHygieneRecommendation {
  code: TokenHygieneReasonCode;
  title: string;
  recommendation: string;
  estimated_waste_microcents: number;
}

interface HygieneAggregateRow {
  identity_id: string;
  request_count: number | string;
  total_input_tokens: number | string | null;
  total_output_tokens: number | string | null;
  actual_cost_microcents: number | string | null;
  avg_input_tokens: number | string | null;
  max_input_tokens: number | string | null;
  requests_over_128k: number | string | null;
  requests_over_500k: number | string | null;
  requests_over_1m: number | string | null;
  avg_system_prompt_tokens: number | string | null;
  cache_hit_count: number | string | null;
  error_count: number | string | null;
  duplicate_request_count: number | string | null;
  duplicate_waste_microcents: number | string | null;
}

export interface TokenHygieneRecord {
  identity_id: string;
  request_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  actual_cost_microcents: number;
  avg_input_tokens: number;
  max_input_tokens: number;
  requests_over_128k: number;
  requests_over_500k: number;
  requests_over_1m: number;
  pct_over_128k: number;
  pct_over_500k: number;
  pct_over_1m: number;
  avg_system_prompt_tokens: number;
  cache_hit_rate: number;
  error_rate: number;
  duplicate_request_count: number;
  duplicate_rate: number;
  estimated_waste_microcents: number;
  score: number;
  grade: 'excellent' | 'good' | 'watch' | 'poor';
  reasons: TokenHygieneReasonCode[];
  recommendations: TokenHygieneRecommendation[];
}


export async function handleTokenHygiene(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  const clickhouseUrl = process.env.CLICKHOUSE_URL ?? config.clickhouseUrl;
  const rows = clickhouseUrl
    ? await queryTokenHygieneFromClickHouse(clickhouseUrl, teamId, parsed.start)
    : await queryTokenHygieneFromPostgres(teamId, parsed.start, parsed.end);

  const records = rows.map(toTokenHygieneRecord);
  const summary = buildSummary(records);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ month: parsed.month, team_id: teamId, summary, records }));
}


async function queryTokenHygieneFromPostgres(teamId: string, start: Date, end: Date): Promise<HygieneAggregateRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<HygieneAggregateRow>(
    `WITH base AS (
       SELECT
         -- AXI-8: logged snapshot is the attribution of record. The writer
         -- stores '' for key-without-identity requests (ClickHouse
         -- convention), so the snapshot arm must NOT go through NULLIF: ''
         -- is "known unattributed" and must never fall back. Only a genuine
         -- NULL — a pre-migration row — may fall back to current key
         -- metadata, bounding the legacy window structurally.
         COALESCE(l.layer_identity_id, k.metadata->>'layer_identity_id') AS identity_id,
         l.input_tokens,
         l.output_tokens,
         l.actual_cost_microcents,
         l.system_prompt_tokens,
         l.cache_hit,
         l.status_code,
         l.message_hash
       FROM request_logs l
       -- LEFT JOIN: a snapshotted row must surface even without an api_key_id
       -- row; the join only feeds the legacy metadata fallback. k.team_id
       -- pinned to l.team_id so a stale api_key_id can't borrow another
       -- tenant's identity label.
       LEFT JOIN api_keys k ON k.id = l.api_key_id AND k.team_id = l.team_id
       WHERE l.team_id = $1
         AND l.timestamp >= $2
         AND l.timestamp < $3
         AND (
           NULLIF(l.layer_identity_id, '') IS NOT NULL
           OR (l.layer_identity_id IS NULL AND NULLIF(k.metadata->>'layer_identity_id', '') IS NOT NULL)
         )
     ), duplicate_hashes AS (
       SELECT identity_id, message_hash, COUNT(*)::int AS duplicate_group_count, SUM(actual_cost_microcents)::bigint AS duplicate_group_cost
       FROM base
       WHERE message_hash IS NOT NULL AND message_hash != ''
         -- Cache hits already prevented the upstream spend, so a repeated
         -- request served from cache is not wasted money. Excluding them also
         -- stops the contradictory low_cache_hit_on_repeated_work signal from
         -- firing on duplicates the cache actually absorbed.
         AND NOT COALESCE(cache_hit, false)
       GROUP BY identity_id, message_hash
       HAVING COUNT(*) > 1
     ), duplicate_rollup AS (
       SELECT
         identity_id,
         COALESCE(SUM(duplicate_group_count - 1), 0)::bigint AS duplicate_request_count,
         COALESCE(SUM(duplicate_group_cost * ((duplicate_group_count - 1)::numeric / duplicate_group_count)), 0)::bigint AS duplicate_waste_microcents
       FROM duplicate_hashes
       GROUP BY identity_id
     )
     SELECT
       b.identity_id,
       COUNT(*)::bigint AS request_count,
       COALESCE(SUM(b.input_tokens), 0)::bigint AS total_input_tokens,
       COALESCE(SUM(b.output_tokens), 0)::bigint AS total_output_tokens,
       COALESCE(SUM(b.actual_cost_microcents), 0)::bigint AS actual_cost_microcents,
       COALESCE(AVG(b.input_tokens), 0)::float AS avg_input_tokens,
       COALESCE(MAX(b.input_tokens), 0)::bigint AS max_input_tokens,
       COUNT(*) FILTER (WHERE b.input_tokens >= 128000)::bigint AS requests_over_128k,
       COUNT(*) FILTER (WHERE b.input_tokens >= 500000)::bigint AS requests_over_500k,
       COUNT(*) FILTER (WHERE b.input_tokens >= 1000000)::bigint AS requests_over_1m,
       COALESCE(AVG(COALESCE(b.system_prompt_tokens, 0)), 0)::float AS avg_system_prompt_tokens,
       COUNT(*) FILTER (WHERE COALESCE(b.cache_hit, false))::bigint AS cache_hit_count,
       COUNT(*) FILTER (WHERE b.status_code >= 400)::bigint AS error_count,
       COALESCE(d.duplicate_request_count, 0)::bigint AS duplicate_request_count,
       COALESCE(d.duplicate_waste_microcents, 0)::bigint AS duplicate_waste_microcents
     FROM base b
     LEFT JOIN duplicate_rollup d ON d.identity_id = b.identity_id
     GROUP BY b.identity_id, d.duplicate_request_count, d.duplicate_waste_microcents
     ORDER BY actual_cost_microcents DESC`,
    [teamId, start.toISOString(), end.toISOString()],
  );
  return rows;
}

async function queryTokenHygieneFromClickHouse(clickhouseUrl: string, teamId: string, start: Date): Promise<HygieneAggregateRow[]> {
  const month = start.toISOString().slice(0, 10);
  const query = [
    'WITH identity_rollup AS (',
    '  SELECT',
    '    layer_identity_id AS identity_id,',
    '    countMerge(request_count) AS request_count,',
    '    sumMerge(total_input_tokens) AS total_input_tokens,',
    '    sumMerge(total_output_tokens) AS total_output_tokens,',
    '    sumMerge(actual_cost_microcents) AS actual_cost_microcents,',
    '    if(countMerge(request_count) = 0, 0, sumMerge(total_input_tokens) / countMerge(request_count)) AS avg_input_tokens,',
    '    maxMerge(max_input_tokens) AS max_input_tokens,',
    '    countIfMerge(requests_over_128k) AS requests_over_128k,',
    '    countIfMerge(requests_over_500k) AS requests_over_500k,',
    '    countIfMerge(requests_over_1m) AS requests_over_1m,',
    '    if(countMerge(request_count) = 0, 0, sumMerge(system_prompt_tokens_sum) / countMerge(request_count)) AS avg_system_prompt_tokens,',
    '    countIfMerge(cache_hit_count) AS cache_hit_count,',
    '    countIfMerge(error_count) AS error_count',
    '  FROM token_hygiene_identity_monthly',
    '  WHERE team_id = {team_id:String} AND month = toDate({month:String})',
    '  GROUP BY layer_identity_id',
    '), duplicate_groups AS (',
    '  SELECT',
    '    layer_identity_id AS identity_id,',
    '    message_hash,',
    '    sum(request_count) AS request_count,',
    '    sum(actual_cost_microcents) AS actual_cost_microcents',
    '  FROM token_hygiene_fingerprint_monthly',
    '  WHERE team_id = {team_id:String} AND month = toDate({month:String})',
    '  GROUP BY layer_identity_id, message_hash',
    '), duplicate_rollup AS (',
    '  SELECT',
    '    identity_id,',
    '    sum(if(request_count > 1, request_count - 1, 0)) AS duplicate_request_count,',
    // RSH-55: ClickHouse `/` is float division, so this sum is fractional.
    // The Postgres path casts the equivalent SUM to ::bigint (round once at the
    // end), so cast here too — otherwise the two backends report different
    // (fractional vs integer) microcent waste for the same data.
    '    toInt64(round(sum(if(request_count > 1, actual_cost_microcents * ((request_count - 1) / request_count), 0)))) AS duplicate_waste_microcents',
    '  FROM duplicate_groups',
    '  GROUP BY identity_id',
    ')',
    'SELECT',
    '  i.identity_id, i.request_count, i.total_input_tokens, i.total_output_tokens,',
    '  i.actual_cost_microcents, i.avg_input_tokens, i.max_input_tokens,',
    '  i.requests_over_128k, i.requests_over_500k, i.requests_over_1m,',
    '  i.avg_system_prompt_tokens, i.cache_hit_count, i.error_count,',
    '  coalesce(d.duplicate_request_count, 0) AS duplicate_request_count,',
    '  coalesce(d.duplicate_waste_microcents, 0) AS duplicate_waste_microcents',
    'FROM identity_rollup i',
    'LEFT JOIN duplicate_rollup d ON d.identity_id = i.identity_id',
    'ORDER BY actual_cost_microcents DESC',
    'FORMAT JSONEachRow',
  ].join('\n');
  const response = await fetch(clickHouseQueryUrl(clickhouseUrl, query, { team_id: teamId, month }), { method: 'POST' });
  if (!response.ok) throw new Error(`ClickHouse token hygiene query failed with status ${response.status}`);
  const text = await response.text();
  if (!text.trim()) return [];
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as HygieneAggregateRow);
}

function toNumber(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function toTokenHygieneRecord(row: HygieneAggregateRow): TokenHygieneRecord {
  const requestCount = toNumber(row.request_count);
  const requestsOver128k = toNumber(row.requests_over_128k);
  const requestsOver500k = toNumber(row.requests_over_500k);
  const requestsOver1m = toNumber(row.requests_over_1m);
  const cacheHitCount = toNumber(row.cache_hit_count);
  const errorCount = toNumber(row.error_count);
  const duplicateRequestCount = toNumber(row.duplicate_request_count);
  const duplicateWaste = toNumber(row.duplicate_waste_microcents);

  const recordBase = {
    identity_id: row.identity_id,
    request_count: requestCount,
    total_input_tokens: toNumber(row.total_input_tokens),
    total_output_tokens: toNumber(row.total_output_tokens),
    actual_cost_microcents: toNumber(row.actual_cost_microcents),
    avg_input_tokens: Math.round(toNumber(row.avg_input_tokens)),
    max_input_tokens: toNumber(row.max_input_tokens),
    requests_over_128k: requestsOver128k,
    requests_over_500k: requestsOver500k,
    requests_over_1m: requestsOver1m,
    pct_over_128k: ratio(requestsOver128k, requestCount),
    pct_over_500k: ratio(requestsOver500k, requestCount),
    pct_over_1m: ratio(requestsOver1m, requestCount),
    avg_system_prompt_tokens: Math.round(toNumber(row.avg_system_prompt_tokens)),
    cache_hit_rate: ratio(cacheHitCount, requestCount),
    error_rate: ratio(errorCount, requestCount),
    duplicate_request_count: duplicateRequestCount,
    duplicate_rate: ratio(duplicateRequestCount, requestCount),
    estimated_waste_microcents: duplicateWaste,
  };

  const scoring = scoreTokenHygiene(recordBase);
  return { ...recordBase, ...scoring, recommendations: buildRecommendations(scoring.reasons, recordBase) };
}

function scoreTokenHygiene(record: Omit<TokenHygieneRecord, 'score' | 'grade' | 'reasons' | 'recommendations'>): Pick<TokenHygieneRecord, 'score' | 'grade' | 'reasons'> {
  const reasons: TokenHygieneReasonCode[] = [];
  let penalty = 0;

  const pctOver500kPenalty = Math.min(25, record.pct_over_500k * 60);
  if (record.pct_over_500k >= 0.05) reasons.push('excessive_context_500k');
  penalty += pctOver500kPenalty;

  const pctOver128kPenalty = Math.min(15, record.pct_over_128k * 25);
  if (record.pct_over_128k >= 0.25) reasons.push('large_context_share_128k');
  penalty += pctOver128kPenalty;

  if (record.avg_input_tokens > 64_000) {
    reasons.push('high_average_context');
    penalty += Math.min(10, (record.avg_input_tokens - 64_000) / 64_000 * 10);
  }

  if (record.avg_system_prompt_tokens > 8_000) {
    reasons.push('oversized_system_prompt');
    penalty += Math.min(15, (record.avg_system_prompt_tokens - 8_000) / 16_000 * 15);
  }

  if (record.duplicate_rate >= 0.10) {
    reasons.push('duplicate_requests');
    penalty += Math.min(20, record.duplicate_rate * 40);
  }

  if (record.duplicate_request_count > 0 && record.cache_hit_rate < 0.10) {
    reasons.push('low_cache_hit_on_repeated_work');
    penalty += 8;
  }

  if (record.error_rate >= 0.05) {
    reasons.push('high_error_rate');
    penalty += Math.min(10, record.error_rate * 100);
  }

  if (record.requests_over_1m > 0) {
    reasons.push('requests_exceed_1m_context');
    penalty += 10;
  }

  const score = Math.max(1, Math.min(100, Math.round(100 - penalty)));
  return { score, grade: gradeForScore(score), reasons };
}


function buildRecommendations(
  reasons: TokenHygieneReasonCode[],
  record: Omit<TokenHygieneRecord, 'score' | 'grade' | 'reasons' | 'recommendations'>,
): TokenHygieneRecommendation[] {
  return reasons.map((code) => ({
    code,
    ...recommendationForReason(code, record),
  }));
}

function recommendationForReason(
  code: TokenHygieneReasonCode,
  record: Omit<TokenHygieneRecord, 'score' | 'grade' | 'reasons' | 'recommendations'>,
): Omit<TokenHygieneRecommendation, 'code'> {
  switch (code) {
    case 'excessive_context_500k':
      return {
        title: 'Reduce oversized context windows',
        recommendation: 'Replace repeated full-context prompts with retrieval, summaries, or file-level excerpts before model calls exceed 500k input tokens.',
        estimated_waste_microcents: Math.round(record.actual_cost_microcents * record.pct_over_500k * 0.35),
      };
    case 'large_context_share_128k':
      return {
        title: 'Review large-context prompt share',
        recommendation: 'Audit workflows over 128k tokens and add context budgets so only the relevant document chunks are sent.',
        estimated_waste_microcents: Math.round(record.actual_cost_microcents * record.pct_over_128k * 0.15),
      };
    case 'high_average_context':
      return {
        title: 'Lower average input tokens',
        recommendation: 'Add pre-call prompt compression or conversation summarization for this identity before requests reach the router.',
        estimated_waste_microcents: Math.round(record.actual_cost_microcents * 0.1),
      };
    case 'oversized_system_prompt':
      return {
        title: 'Compress the system prompt',
        recommendation: 'Move static policy text into a shared prompt template, remove duplicated instructions, and keep per-request system prompts under 8k tokens.',
        estimated_waste_microcents: Math.round(record.actual_cost_microcents * 0.08),
      };
    case 'duplicate_requests':
      return {
        title: 'Stop duplicate requests',
        recommendation: 'Enable idempotency keys, response caching, or session reuse for repeated identical prompts from this identity.',
        estimated_waste_microcents: record.estimated_waste_microcents,
      };
    case 'low_cache_hit_on_repeated_work':
      return {
        title: 'Improve cache eligibility',
        recommendation: 'Review repeated prompts that miss cache; normalize volatile fields and mark deterministic requests cacheable.',
        // Same waste source as duplicate_requests; keep this advisory at zero
        // so dashboard recommendation totals do not double-count one waste pool.
        estimated_waste_microcents: 0,
      };
    case 'high_error_rate':
      return {
        title: 'Fix provider/model errors',
        recommendation: 'Inspect failed requests by provider and model, then add fallback rules or repair invalid request-shape parameters causing retries.',
        estimated_waste_microcents: Math.round(record.actual_cost_microcents * record.error_rate),
      };
    case 'requests_exceed_1m_context':
      return {
        title: 'Block million-token calls by default',
        recommendation: 'Add a max-token guardrail for this workflow and require explicit approval for requests above 1M input tokens.',
        estimated_waste_microcents: Math.round(record.actual_cost_microcents * record.pct_over_1m * 0.5),
      };
  }
}

function gradeForScore(score: number): TokenHygieneRecord['grade'] {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'watch';
  return 'poor';
}

function buildSummary(records: TokenHygieneRecord[]) {
  if (records.length === 0) {
    return {
      identity_count: 0,
      average_score: null,
      lowest_score: null,
      total_estimated_waste_microcents: 0,
      identities_over_500k_context: 0,
      identities_with_duplicate_waste: 0,
    };
  }

  return {
    identity_count: records.length,
    average_score: Math.round(records.reduce((sum, r) => sum + r.score, 0) / records.length),
    lowest_score: Math.min(...records.map((r) => r.score)),
    total_estimated_waste_microcents: records.reduce((sum, r) => sum + r.estimated_waste_microcents, 0),
    identities_over_500k_context: records.filter((r) => r.requests_over_500k > 0).length,
    identities_with_duplicate_waste: records.filter((r) => r.duplicate_request_count > 0).length,
  };
}
