import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  config: { clickhouseUrl: undefined as string | undefined },
}));

vi.mock('../src/config.js', () => ({
  config: mocks.config,
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { handleUsageSavings } from '../src/usage/savings.js';

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

describe('handleUsageSavings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.query.mockReset();
    mocks.config.clickhouseUrl = undefined;
  });

  it('returns monthly positive savings for a required team_id from Postgres when ClickHouse is not configured', async () => {
    mocks.query.mockResolvedValue({
      rows: [{ savings_microcents: '123456789', unknown_cost_requests: '2' }],
    });

    const req = { url: '/v1/usage/savings?team_id=team_123&month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleUsageSavings(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toEqual({
      month: '2026-03',
      team_id: 'team_123',
      savings_microcents: 123456789,
      unknown_cost_requests: 2,
      actual_costs_qualified: false,
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('SUM(GREATEST(savings_microcents, 0))'),
      ['team_123', '2026-03-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'],
    );
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('actual_cost_known = true');
    expect(String(mocks.query.mock.calls[0]?.[0])).toContain('actual_cost_known = false');
  });

  it('returns zero savings when there are no request logs in Postgres', async () => {
    mocks.query.mockResolvedValue({
      rows: [{ savings_microcents: null, unknown_cost_requests: '0' }],
    });

    const req = { url: '/v1/usage/savings?team_id=team_123&month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleUsageSavings(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toMatchObject({
      savings_microcents: 0,
      unknown_cost_requests: 0,
      actual_costs_qualified: true,
    });
  });

  it('queries ClickHouse when CLICKHOUSE_URL is configured', async () => {
    mocks.config.clickhouseUrl = 'http://clickhouse.test';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '{"savings_microcents":"987654","unknown_cost_requests":"1"}\n',
    }));

    const req = { url: '/v1/usage/savings?team_id=team_123&month=2026-03' } as IncomingMessage;
    const out = makeRes();

    await handleUsageSavings(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body)).toMatchObject({
      savings_microcents: 987654,
      unknown_cost_requests: 1,
      actual_costs_qualified: false,
    });
    expect(mocks.query).not.toHaveBeenCalled();

    const fetchMock = vi.mocked(global.fetch);
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    const parsedUrl = new URL(calledUrl);
    const decodedQuery = parsedUrl.searchParams.get('query') ?? '';
    expect(decodedQuery).toContain('FROM request_logs');
    expect(decodedQuery).toContain('WHERE team_id = {team_id:String}');
    expect(decodedQuery).toContain("timestamp >= toDateTime64({start:String}, 3, 'UTC')");
    expect(decodedQuery).toContain("timestamp < toDateTime64({end:String}, 3, 'UTC')");
    expect(decodedQuery).toContain('countIf(actual_cost_known = 0)');
    expect(parsedUrl.searchParams.get('param_team_id')).toBe('team_123');
    expect(parsedUrl.searchParams.get('param_start')).toBe('2026-03-01 00:00:00');
    expect(parsedUrl.searchParams.get('param_end')).toBe('2026-04-01 00:00:00');
  });

  it('rejects missing or wildcard team_id instead of leaking cross-team savings', async () => {
    const missing = makeRes();
    await handleUsageSavings({ url: '/v1/usage/savings?month=2026-03' } as IncomingMessage, missing.res);

    const wildcard = makeRes();
    await handleUsageSavings({ url: '/v1/usage/savings?team_id=*&month=2026-03' } as IncomingMessage, wildcard.res);

    expect(missing.statusCode).toBe(400);
    expect(wildcard.statusCode).toBe(400);
    expect(JSON.parse(missing.body)).toEqual({ error: { message: 'team_id query parameter is required' } });
    expect(JSON.parse(wildcard.body)).toEqual({ error: { message: 'team_id query parameter is required' } });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects invalid month without querying the database', async () => {
    const req = { url: '/v1/usage/savings?team_id=team_123&month=2026-3' } as IncomingMessage;
    const out = makeRes();

    await handleUsageSavings(req, out.res);

    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toEqual({
      error: { message: 'month query parameter must be in YYYY-MM format' },
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
