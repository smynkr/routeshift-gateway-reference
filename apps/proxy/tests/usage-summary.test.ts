import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockValidate = vi.fn();

vi.mock('../src/config.js', () => ({
  config: { clickhouseUrl: 'http://clickhouse.test', databaseUrl: 'postgres://test' },
}));
vi.mock('../src/db/pool.js', () => ({ getPool: () => ({ query: mockQuery }) }));
vi.mock('../src/auth/api-key.js', () => ({ validateApiKey: (k: string) => mockValidate(k) }));

import { config } from '../src/config.js';
import { handleUsageSummary } from '../src/usage/summary.js';

function makeRes() {
  let statusCode = 0; let body = ''; const headers: Record<string, string> = {};
  const res = {
    setHeader(k: string, v: string) { headers[k] = v; },
    writeHead(c: number, h?: Record<string, string>) { statusCode = c; Object.assign(headers, h ?? {}); return this; },
    end(chunk?: string) { body = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  return { res, get statusCode() { return statusCode; }, get body() { return body; } };
}

const KEY = { authorization: 'Bearer sk-proxy-live_acme_xyz' };

// One ClickHouse response per query the handler issues, in order:
// summary, by_model, by_key, series, contributions.
function stubClickHouse(byQuery: { summary: string; by_model: string; by_key: string; series: string; contributions: string }) {
  const order = ['summary', 'by_model', 'by_key', 'series', 'contributions'] as const;
  let i = 0;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
    const which = order[i++];
    return { ok: true, status: 200, text: async () => byQuery[which] };
  }));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockValidate.mockReset();
  mockValidate.mockResolvedValue({ id: 'key_1', teamId: 'team_acme' });
  config.clickhouseUrl = 'http://clickhouse.test';
  config.databaseUrl = 'postgres://test';
});

// Restore the global `fetch` stub so it never leaks into another test file in
// the same worker (an unrestored stub intermittently breaks server-routing's
// real-fetch tests). Mirrors the restore guard the rest of the proxy suite uses.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('handleUsageSummary auth', () => {
  it('401s with no Authorization header (and issues no query)', async () => {
    const out = makeRes();
    await handleUsageSummary({ headers: {}, url: '/v1/usage/summary' } as IncomingMessage, out.res);
    expect(out.statusCode).toBe(401);
    expect(mockValidate).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('401s when the key is not a sk-proxy- key', async () => {
    const out = makeRes();
    await handleUsageSummary({ headers: { authorization: 'Bearer nope' }, url: '/v1/usage/summary' } as unknown as IncomingMessage, out.res);
    expect(out.statusCode).toBe(401);
    expect(mockValidate).not.toHaveBeenCalled();
  });

  it('401s when validateApiKey returns null', async () => {
    mockValidate.mockResolvedValue(null);
    const out = makeRes();
    await handleUsageSummary({ headers: KEY, url: '/v1/usage/summary' } as unknown as IncomingMessage, out.res);
    expect(out.statusCode).toBe(401);
  });

  it('403s a scoped key that lacks read before any storage query', async () => {
    const noFetch = vi.fn();
    vi.stubGlobal('fetch', noFetch);
    mockValidate.mockResolvedValue({ id: 'key_1', teamId: 'team_acme', metadata: { scope: 'inference' } });

    const out = makeRes();
    await handleUsageSummary({ headers: KEY, url: '/v1/usage/summary' } as unknown as IncomingMessage, out.res);

    expect(out.statusCode).toBe(403);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'insufficient_scope: missing read scope', code: 'insufficient_scope' },
    });
    expect(noFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('allows an unscoped key to read the summary', async () => {
    mockValidate.mockResolvedValue({ id: 'key_1', teamId: 'team_acme', metadata: {} });
    stubClickHouse({
      summary: '{"requests":0,"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,"spend_microcents":0,"savings_microcents":0}',
      by_model: '', by_key: '', series: '', contributions: '',
    });
    mockQuery.mockResolvedValue({ rows: [] });

    const out = makeRes();
    await handleUsageSummary({ headers: KEY, url: '/v1/usage/summary' } as unknown as IncomingMessage, out.res);

    expect(out.statusCode).toBe(200);
  });

  it('allows a key scoped with read to read the summary', async () => {
    mockValidate.mockResolvedValue({ id: 'key_1', teamId: 'team_acme', metadata: { scope: 'read' } });
    stubClickHouse({
      summary: '{"requests":0,"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,"spend_microcents":0,"savings_microcents":0}',
      by_model: '', by_key: '', series: '', contributions: '',
    });
    mockQuery.mockResolvedValue({ rows: [] });

    const out = makeRes();
    await handleUsageSummary({ headers: KEY, url: '/v1/usage/summary' } as unknown as IncomingMessage, out.res);

    expect(out.statusCode).toBe(200);
  });

  it('400s invalid ranges before any storage query', async () => {
    const noFetch = vi.fn();
    vi.stubGlobal('fetch', noFetch);

    const out = makeRes();
    await handleUsageSummary(
      { headers: KEY, url: '/v1/usage/summary?since=2026-06-02T00:00:00.000Z&until=2026-06-01T00:00:00.000Z' } as unknown as IncomingMessage,
      out.res,
    );

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body).error.message).toContain('since must be before until');
    expect(noFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('handleUsageSummary team isolation (security-critical)', () => {
  it('ignores a ?team_id= param and binds the query to the KEY team only', async () => {
    stubClickHouse({
      summary: '{"requests":3,"input_tokens":10,"output_tokens":4,"cache_read_tokens":2,"cache_write_tokens":1,"spend_microcents":1200,"savings_microcents":300,"unknown_cost_requests":1}',
      by_model: '', by_key: '', series: '', contributions: '',
    });
    mockQuery.mockResolvedValue({ rows: [] }); // api_keys lookup + credit lookup

    const out = makeRes();
    await handleUsageSummary(
      { headers: KEY, url: '/v1/usage/summary?team_id=team_victim' } as unknown as IncomingMessage,
      out.res,
    );

    expect(out.statusCode).toBe(200);
    const fetchMock = vi.mocked(global.fetch);
    // Every ClickHouse call must bind param_team_id to the KEY's team, never the param.
    for (const call of fetchMock.mock.calls) {
      const url = new URL(call[0] as string);
      expect(url.searchParams.get('param_team_id')).toBe('team_acme');
      expect(url.searchParams.get('param_team_id')).not.toBe('team_victim');
      // searchParams.get already returns the decoded SQL; do NOT decodeURIComponent
      // again — the SQL contains ClickHouse %Y/%m specifiers (invalid percent-escapes).
      expect(url.searchParams.get('query') ?? '').not.toContain('team_victim');
    }
  });
});

describe('handleUsageSummary shape (ClickHouse path)', () => {
  it('returns the data envelope with floored routing savings and billed spend', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    stubClickHouse({
      summary: '{"requests":3,"input_tokens":10,"output_tokens":4,"cache_read_tokens":2,"cache_write_tokens":1,"spend_microcents":1200,"savings_microcents":300,"unknown_cost_requests":1}',
      by_model: '{"model":"claude-opus-4-8","provider":"anthropic","requests":2,"input_tokens":8,"output_tokens":3,"spend_microcents":1000,"savings_microcents":250,"unknown_cost_requests":1}',
      by_key: '{"api_key_id":"key_1","requests":3,"spend_microcents":1200,"savings_microcents":300,"unknown_cost_requests":1}',
      series: '{"bucket_start":"2026-05-31T00:00:00.000Z","spend_microcents":1200,"input_tokens":10,"output_tokens":4,"requests":3,"unknown_cost_requests":1}',
      contributions: '{"date":"2026-06-01","spend_microcents":1200,"tokens":14,"unknown_cost_requests":1}',
    });
    // First Postgres call: api_keys prefix lookup. Second: credit_balances.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'key_1', key_prefix: 'sk-proxy-live_acme' }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '5000000000' }] });

    const out = makeRes();
    await handleUsageSummary({ headers: KEY, url: '/v1/usage/summary?since=30d&bucket=day' } as unknown as IncomingMessage, out.res);

    expect(out.statusCode).toBe(200);
    const data = JSON.parse(out.body).data;
    expect(Object.keys(data)).toEqual(['range', 'summary', 'by_model', 'by_key', 'series', 'contributions']);
    expect(data.summary).toMatchObject({ requests: 3, spend_microcents: 1200, savings_microcents: 300, unknown_cost_requests: 1, actual_costs_qualified: false, credit_balance_microcents: 5000000000 });
    expect(data.by_model[0]).toMatchObject({ model: 'claude-opus-4-8', provider: 'anthropic', unknown_cost_requests: 1, actual_costs_qualified: false });
    expect(data.by_key[0]).toMatchObject({ api_key_id: 'key_1', key_prefix: 'sk-proxy-live_acme', unknown_cost_requests: 1, actual_costs_qualified: false });
    expect(data.range.bucket).toBe('day');
    expect(Array.isArray(data.contributions)).toBe(true);
    expect(data.series.find((row: { unknown_cost_requests: number }) => row.unknown_cost_requests === 1)).toMatchObject({ actual_costs_qualified: false });
    expect(data.contributions.at(-1)).toMatchObject({ date: expect.any(String), level: expect.any(Number), unknown_cost_requests: 1, actual_costs_qualified: false });
    const queries = vi.mocked(global.fetch).mock.calls.map(([url]) => new URL(url as string).searchParams.get('query') ?? '');
    const summaryQuery = queries[0];
    expect(summaryQuery).toContain('actual_cost_microcents + COALESCE(plugin_cost_microcents, 0)');
    for (const query of queries.slice(0, 3)) {
      expect(query).toContain('actual_cost_known = 1 AND savings_microcents > 0');
    }
    for (const query of queries) expect(query).toContain('countIf(actual_cost_known = 0)');
  });

  it('floors negative savings to 0 via the SQL GREATEST/if pattern', async () => {
    stubClickHouse({
      summary: '{"requests":1,"input_tokens":1,"output_tokens":1,"cache_read_tokens":0,"cache_write_tokens":0,"spend_microcents":100,"savings_microcents":0}',
      by_model: '', by_key: '', series: '', contributions: '',
    });
    mockQuery.mockResolvedValue({ rows: [] });
    const out = makeRes();
    await handleUsageSummary({ headers: KEY, url: '/v1/usage/summary' } as unknown as IncomingMessage, out.res);
    const data = JSON.parse(out.body).data;
    expect(data.summary.savings_microcents).toBe(0);
    // assert the SQL uses the flooring idiom on the savings aggregate
    const summaryUrl = new URL(vi.mocked(global.fetch).mock.calls[0][0] as string);
    expect(summaryUrl.searchParams.get('query') ?? '').toMatch(/savings_microcents > 0/);
    expect(summaryUrl.searchParams.get('query') ?? '').toContain('plugin_cost_microcents');
  });
});

describe('handleUsageSummary Postgres fallback (CLICKHOUSE_URL unset)', () => {
  it('serves from Postgres without a 500 and reports cache tokens as 0', async () => {
    config.clickhouseUrl = undefined;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:00:00.000Z'));
    const noFetch = vi.fn();
    vi.stubGlobal('fetch', noFetch);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ requests: '2', input_tokens: '10', output_tokens: '4', spend_microcents: '900', savings_microcents: '100', unknown_cost_requests: '1' }] })
      .mockResolvedValueOnce({ rows: [{ model: 'gpt-4.1', provider: 'openai', requests: '2', input_tokens: '10', output_tokens: '4', spend_microcents: '900', savings_microcents: '100', unknown_cost_requests: '1' }] })
      .mockResolvedValueOnce({ rows: [{ api_key_id: 'key_1', requests: '2', spend_microcents: '900', savings_microcents: '100', unknown_cost_requests: '1' }] })
      .mockResolvedValueOnce({ rows: [{ bucket_start: '2026-06-01T00:00:00.000Z', spend_microcents: '900', input_tokens: '10', output_tokens: '4', requests: '2', unknown_cost_requests: '1' }] })
      .mockResolvedValueOnce({ rows: [{ date: '2026-06-01', spend_microcents: '900', tokens: '14', unknown_cost_requests: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'key_1', key_prefix: 'sk-proxy-live_acme' }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '0' }] });

    const out = makeRes();
    await handleUsageSummary({ headers: KEY, url: '/v1/usage/summary' } as unknown as IncomingMessage, out.res);

    expect(out.statusCode).toBe(200);
    expect(noFetch).not.toHaveBeenCalled();
    const data = JSON.parse(out.body).data;
    expect(data.summary).toMatchObject({ requests: 2, spend_microcents: 900, cache_read_tokens: 0, cache_write_tokens: 0, unknown_cost_requests: 1, actual_costs_qualified: false });
    expect(data.by_key[0]).toMatchObject({ key_prefix: 'sk-proxy-live_acme', unknown_cost_requests: 1, actual_costs_qualified: false });
    expect(data.series.find((row: { unknown_cost_requests: number }) => row.unknown_cost_requests === 1)).toMatchObject({ actual_costs_qualified: false });
    expect(data.contributions.at(-1)).toMatchObject({ unknown_cost_requests: 1, actual_costs_qualified: false });
    for (const [sql] of mockQuery.mock.calls.slice(0, 5)) expect(sql).toContain('actual_cost_known = false');
    for (const [sql] of mockQuery.mock.calls.slice(0, 3)) expect(sql).toContain('FILTER (WHERE actual_cost_known = true)');
  });

  it('falls back to Postgres values when configured ClickHouse fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ requests: '4', input_tokens: '40', output_tokens: '12', spend_microcents: '1800', savings_microcents: '250' }] })
      .mockResolvedValueOnce({ rows: [{ model: 'gpt-4.1', provider: 'openai', requests: '4', input_tokens: '40', output_tokens: '12', spend_microcents: '1800', savings_microcents: '250' }] })
      .mockResolvedValueOnce({ rows: [{ api_key_id: 'key_1', requests: '4', spend_microcents: '1800', savings_microcents: '250' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'key_1', key_prefix: 'sk-proxy-live_acme' }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '700' }] });

    const out = makeRes();
    await handleUsageSummary({ headers: KEY, url: '/v1/usage/summary' } as unknown as IncomingMessage, out.res);

    expect(out.statusCode).toBe(200);
    expect(vi.mocked(global.fetch)).toHaveBeenCalled();
    const data = JSON.parse(out.body).data;
    expect(data.summary).toMatchObject({
      requests: 4,
      spend_microcents: 1800,
      savings_microcents: 250,
      credit_balance_microcents: 700,
    });
    expect(data.by_model[0]).toMatchObject({ model: 'gpt-4.1', provider: 'openai', requests: 4 });
  });

  it('queries contribution rows from the first UTC midnight through the day after today', async () => {
    config.clickhouseUrl = undefined;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T12:30:00.000Z'));
    mockQuery
      .mockResolvedValueOnce({ rows: [{ requests: '1', input_tokens: '10', output_tokens: '5', spend_microcents: '600', savings_microcents: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ date: '2026-05-30', spend_microcents: '600', tokens: '15' }] })
      .mockResolvedValueOnce({ rows: [{ balance_microcents: '0' }] });

    const out = makeRes();
    await handleUsageSummary(
      { headers: KEY, url: '/v1/usage/summary?contrib_days=3' } as unknown as IncomingMessage,
      out.res,
    );

    expect(out.statusCode).toBe(200);
    const contribParams = mockQuery.mock.calls[4][1] as string[];
    expect(contribParams).toEqual(['team_acme', '2026-05-30T00:00:00.000Z', '2026-06-02T00:00:00.000Z']);
    const data = JSON.parse(out.body).data;
    expect(data.contributions[0]).toEqual({
      date: '2026-05-30',
      spend_microcents: 600,
      tokens: 15,
      unknown_cost_requests: 0,
      actual_costs_qualified: true,
      level: 4,
    });
  });
});
