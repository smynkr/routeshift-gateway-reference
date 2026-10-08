import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { handleTokenHygiene } from '../src/usage/token-hygiene.js';

function makeRes() {
  let statusCode = 0;
  let body = '';
  const headers: Record<string, string> = {};

  const res = {
    writeHead(code: number, nextHeaders: Record<string, string>) {
      statusCode = code;
      Object.assign(headers, nextHeaders);
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;

  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
}

describe('handleTokenHygiene', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('returns scored token hygiene records with exact reason codes', async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          identity_id: 'identity-bad',
          request_count: '10',
          total_input_tokens: '6200000',
          total_output_tokens: '10000',
          actual_cost_microcents: '10000000',
          avg_input_tokens: '620000',
          max_input_tokens: '1200000',
          requests_over_128k: '8',
          requests_over_500k: '6',
          requests_over_1m: '1',
          avg_system_prompt_tokens: '25000',
          cache_hit_count: '0',
          error_count: '1',
          duplicate_request_count: '3',
          duplicate_waste_microcents: '2500000',
        },
        {
          identity_id: 'identity-good',
          request_count: '20',
          total_input_tokens: '200000',
          total_output_tokens: '50000',
          actual_cost_microcents: '1000000',
          avg_input_tokens: '10000',
          max_input_tokens: '30000',
          requests_over_128k: '0',
          requests_over_500k: '0',
          requests_over_1m: '0',
          avg_system_prompt_tokens: '1000',
          cache_hit_count: '6',
          error_count: '0',
          duplicate_request_count: '0',
          duplicate_waste_microcents: '0',
        },
      ],
    });

    const req = { url: '/admin/usage/token-hygiene?team_id=team_123&month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleTokenHygiene(req, out.res);

    expect(out.statusCode).toBe(200);
    const json = JSON.parse(out.body) as { summary: any; records: any[] };
    expect(json.records).toHaveLength(2);
    expect(json.records[0]).toMatchObject({
      identity_id: 'identity-bad',
      pct_over_500k: 0.6,
      duplicate_rate: 0.3,
      estimated_waste_microcents: 2500000,
      grade: 'poor',
    });
    expect(json.records[0].score).toBeLessThan(50);
    expect(json.records[0].reasons).toEqual(expect.arrayContaining([
      'excessive_context_500k',
      'large_context_share_128k',
      'high_average_context',
      'oversized_system_prompt',
      'duplicate_requests',
      'low_cache_hit_on_repeated_work',
      'high_error_rate',
      'requests_exceed_1m_context',
    ]));
    expect(json.records[0].recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'duplicate_requests',
        title: 'Stop duplicate requests',
        recommendation: expect.stringContaining('response caching'),
        estimated_waste_microcents: 2500000,
      }),
      expect.objectContaining({
        code: 'excessive_context_500k',
        recommendation: expect.stringContaining('retrieval'),
      }),
    ]));
    expect(json.records[1]).toMatchObject({ identity_id: 'identity-good', score: 100, grade: 'excellent', reasons: [], recommendations: [] });
    expect(json.summary).toMatchObject({
      identity_count: 2,
      lowest_score: json.records[0].score,
      total_estimated_waste_microcents: 2500000,
      identities_over_500k_context: 1,
      identities_with_duplicate_waste: 1,
    });
  });

  it('groups the Postgres path on the immutable logged snapshot; current metadata is only a legacy fallback (AXI-8)', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const out = makeRes();

    await handleTokenHygiene(
      { url: '/admin/usage/token-hygiene?team_id=team_123&month=2026-03' } as IncomingMessage,
      out.res,
    );

    expect(out.statusCode).toBe(200);
    // Strip comments so explanatory text can't mask the pinned clauses.
    const sql = (mocks.query.mock.calls[0]?.[0] as string)
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ');
    // Snapshot arm must NOT pass through NULLIF: '' is the "known
    // unattributed" sentinel the writer stores post-migration and must block
    // the metadata fallback; only genuine pre-migration NULLs fall back.
    const snapshotFirst =
      "COALESCE(l.layer_identity_id, k.metadata->>'layer_identity_id')";
    expect(sql).toContain(`${snapshotFirst} AS identity_id`);
    expect(sql).not.toContain("k.metadata->>'layer_identity_id' AS identity_id");
    // Snapshotted rows survive key-metadata edits, revocation, and
    // NULL/missing api_key_id rows — the snapshot, not the join, owns
    // attribution. k.team_id = l.team_id pins the fallback label to the
    // same tenant.
    expect(sql).toContain('LEFT JOIN api_keys k ON k.id = l.api_key_id AND k.team_id = l.team_id');
    expect(sql).not.toContain('FROM request_logs l JOIN api_keys');
    // Parenthesized OR pinned: without parens, AND/OR precedence would lift
    // the metadata predicate out of the team/window conjuncts and leak
    // cross-tenant rows.
    expect(sql).toContain(
      "AND ( NULLIF(l.layer_identity_id, '') IS NOT NULL OR (l.layer_identity_id IS NULL AND NULLIF(k.metadata->>'layer_identity_id', '') IS NOT NULL) )",
    );
    // The old metadata-only predicate is fully gone.
    expect(sql).not.toContain("k.metadata ? 'layer_identity_id'");
  });


  it('queries ClickHouse token hygiene rollups when CLICKHOUSE_URL is configured', async () => {
    const originalUrl = process.env.CLICKHOUSE_URL;
    process.env.CLICKHOUSE_URL = 'https://clickhouse.test';
    const fetchMock = vi.fn(async () => new Response(`${JSON.stringify({
      identity_id: 'identity-ch',
      request_count: 4,
      total_input_tokens: 2_400_000,
      total_output_tokens: 5_000,
      actual_cost_microcents: 4_000_000,
      avg_input_tokens: 600_000,
      max_input_tokens: 1_100_000,
      requests_over_128k: 4,
      requests_over_500k: 3,
      requests_over_1m: 1,
      avg_system_prompt_tokens: 9_000,
      cache_hit_count: 0,
      error_count: 1,
      duplicate_request_count: 2,
      duplicate_waste_microcents: 1_500_000,
    })}
`, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      const out = makeRes();
      await handleTokenHygiene({ url: '/admin/usage/token-hygiene?team_id=team_ch&month=2026-05' } as IncomingMessage, out.res);
      expect(out.statusCode).toBe(200);
      expect(mocks.query).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = String(fetchMock.mock.calls[0][0]);
      const parsedUrl = new URL(url);
      const query = parsedUrl.searchParams.get('query') ?? '';
      expect(query).toContain('FROM token_hygiene_identity_monthly');
      expect(query).toContain('FROM token_hygiene_fingerprint_monthly');
      expect(query).toContain('WHERE team_id = {team_id:String} AND month = toDate({month:String})');
      expect(parsedUrl.searchParams.get('param_team_id')).toBe('team_ch');
      expect(parsedUrl.searchParams.get('param_month')).toBe('2026-05-01');
      const json = JSON.parse(out.body) as { records: any[] };
      expect(json.records[0]).toMatchObject({ identity_id: 'identity-ch', score: expect.any(Number) });
      expect(json.records[0].recommendations.length).toBeGreaterThan(0);
    } finally {
      if (originalUrl === undefined) delete process.env.CLICKHOUSE_URL;
      else process.env.CLICKHOUSE_URL = originalUrl;
      vi.unstubAllGlobals();
    }
  });

  it('rejects missing team_id and invalid month without querying', async () => {
    const missing = makeRes();
    await handleTokenHygiene({ url: '/admin/usage/token-hygiene?month=2026-03' } as IncomingMessage, missing.res);
    const invalidMonth = makeRes();
    await handleTokenHygiene({ url: '/admin/usage/token-hygiene?team_id=team_123&month=2026-3' } as IncomingMessage, invalidMonth.res);

    expect(missing.statusCode).toBe(400);
    expect(invalidMonth.statusCode).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
