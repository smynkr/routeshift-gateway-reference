import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../src/config.js', () => ({
  config: {
    clickhouseUrl: 'http://clickhouse.test',
    databaseUrl: 'postgres://test',
  },
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { config } from '../src/config.js';
import { handleMonthlyUsage, parseUsageMonth } from '../src/usage/monthly.js';

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
    get headers() {
      return headers;
    },
  };
}

describe('parseUsageMonth', () => {
  it('parses valid month', () => {
    const parsed = parseUsageMonth('2026-03');
    expect(parsed?.month).toBe('2026-03');
    expect(parsed?.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(parsed?.end.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rejects invalid format', () => {
    expect(parseUsageMonth('2026-3')).toBeNull();
    expect(parseUsageMonth('03-2026')).toBeNull();
    expect(parseUsageMonth('2026-13')).toBeNull();
  });
});

describe('handleMonthlyUsage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockQuery.mockReset();
    config.clickhouseUrl = 'http://clickhouse.test';
    config.databaseUrl = 'postgres://test';
  });

  it('returns monthly usage records with user emails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          '{"user_id":"team_a","original_model":"gpt-4.1","routed_model":"gpt-4.1-mini","total_input_tokens":100,"total_output_tokens":40,"actual_cost_microcents":1200,"plugin_cost_microcents":50,"billed_cost_microcents":1250,"request_count":3,"unknown_cost_requests":1}\n' +
          '{"user_id":"team_b","original_model":"claude-3.7-sonnet","routed_model":"claude-3.5-haiku","total_input_tokens":80,"total_output_tokens":20,"actual_cost_microcents":900,"plugin_cost_microcents":0,"billed_cost_microcents":900,"request_count":2,"unknown_cost_requests":0}',
      }),
    );

    mockQuery.mockResolvedValue({
      rows: [{ user_id: 'team_a', user_email: 'owner@team-a.com' }],
    });

    const req = { url: '/v1/usage/monthly?month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleMonthlyUsage(req, out.res);

    expect(out.statusCode).toBe(200);
    const json = JSON.parse(out.body) as {
      month: string;
      records: Array<{ user_id: string; user_email: string | null }>;
    };

    expect(json.month).toBe('2026-03');
    expect(json.records).toHaveLength(2);
    expect(json.records[0]).toMatchObject({ user_id: 'team_a', user_email: 'owner@team-a.com' });
    expect(json.records[1]).toMatchObject({ user_id: 'team_b', user_email: null });
    expect(json.records[0]).toMatchObject({
      actual_cost_microcents: 1200,
      plugin_cost_microcents: 50,
      billed_cost_microcents: 1250,
      unknown_cost_requests: 1,
      actual_costs_qualified: false,
    });
    expect(mockQuery).toHaveBeenCalledTimes(1);

    const fetchMock = vi.mocked(global.fetch);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    const decodedQuery = decodeURIComponent(calledUrl.split('query=')[1] ?? '');
    // Query the raw request_logs table — savings_hourly_mv has no model/token
    // columns, so the previous query referenced non-existent columns.
    expect(decodedQuery).toContain('FROM request_logs');
    expect(decodedQuery).toContain("WHERE timestamp >= toDateTime64('2026-03-01 00:00:00', 3, 'UTC')");
    expect(decodedQuery).toContain("AND timestamp < toDateTime64('2026-04-01 00:00:00', 3, 'UTC')");
    expect(decodedQuery).toContain('GROUP BY user_id, original_model, routed_model');
    expect(decodedQuery).toContain('plugin_cost_microcents');
    expect(decodedQuery).toContain('billed_cost_microcents');
    expect(decodedQuery).toContain('countIf(actual_cost_known = 0) AS unknown_cost_requests');
  });

  it('returns empty records when ClickHouse response body is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '   ',
      }),
    );

    const req = { url: '/v1/usage/monthly?month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleMonthlyUsage(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ month: '2026-03', records: [] });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('normalizes missing ClickHouse fields into safe defaults', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{"user_id":"team_x"}',
      }),
    );
    mockQuery.mockResolvedValue({ rows: [] });

    const req = { url: '/v1/usage/monthly?month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleMonthlyUsage(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toEqual({
      month: '2026-03',
      records: [
        {
          user_id: 'team_x',
          original_model: '',
          routed_model: '',
          total_input_tokens: 0,
          total_output_tokens: 0,
          actual_cost_microcents: 0,
          plugin_cost_microcents: 0,
          billed_cost_microcents: 0,
          request_count: 0,
          unknown_cost_requests: 0,
          actual_costs_qualified: true,
          user_email: null,
        },
      ],
    });
  });

  it('does not query postgres user emails when databaseUrl is disabled', async () => {
    config.databaseUrl = undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => '{"user_id":"team_only","original_model":"gpt","routed_model":"gpt","total_input_tokens":1,"total_output_tokens":2,"actual_cost_microcents":3,"plugin_cost_microcents":0,"billed_cost_microcents":3,"request_count":1}',
      }),
    );

    const req = { url: '/v1/usage/monthly?month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleMonthlyUsage(req, out.res);

    expect(out.statusCode).toBe(200);
    const json = JSON.parse(out.body) as { records: Array<{ user_email: string | null }> };
    expect(json.records[0].user_email).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('bubbles ClickHouse errors for upstream handler visibility', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'unavailable',
      }),
    );

    const req = { url: '/v1/usage/monthly?month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await expect(handleMonthlyUsage(req, out.res)).rejects.toThrow(
      'ClickHouse monthly usage query failed with status 503',
    );
  });

  it('returns 400 for invalid month', async () => {
    const req = { url: '/v1/usage/monthly?month=2026-3' } as IncomingMessage;
    const out = makeRes();

    await handleMonthlyUsage(req, out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'month query parameter must be in YYYY-MM format' },
    });
  });

  it('returns 500 when clickhouse is not configured', async () => {
    config.clickhouseUrl = undefined;
    const req = { url: '/v1/usage/monthly?month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleMonthlyUsage(req, out.res);

    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'CLICKHOUSE_URL is not configured' },
    });
  });
});
