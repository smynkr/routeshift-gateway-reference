import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: queryMock }) }));
// Mutable config mock so individual tests can flip the ClickHouse branch on/off.
const cfg = vi.hoisted(() => ({ clickhouseUrl: undefined as string | undefined }));
vi.mock('../config.js', () => ({ config: cfg }));

import { handleSavingsSeries } from './savings-series.js';

function makeRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    writeHead(code: number, headers: Record<string, string>) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
    },
  };
}

describe('handleSavingsSeries', () => {
  beforeEach(() => {
    queryMock.mockReset();
    cfg.clickhouseUrl = undefined; // default: Postgres branch
  });
  afterEach(() => vi.unstubAllGlobals());

  it('400s when team_id is missing', async () => {
    const res = makeRes();
    await handleSavingsSeries(
      { url: '/admin/usage/savings-series?month=2026-06' } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('400s when month is missing or malformed', async () => {
    const res = makeRes();
    await handleSavingsSeries(
      { url: '/admin/usage/savings-series?team_id=org-1&month=2026-6' } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns a team-scoped daily series with numeric microcents (Postgres)', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          day: '2026-06-01',
          original_microcents: 300,
          actual_microcents: 100,
          plugin_microcents: 25,
          billed_microcents: 125,
          savings_microcents: 200,
          requests: 5,
          unknown_cost_requests: 1,
        },
      ],
    });
    const res = makeRes();
    await handleSavingsSeries(
      { url: '/admin/usage/savings-series?team_id=org-1&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.month).toBe('2026-06');
    expect(body.team_id).toBe('org-1');
    expect(body.series).toHaveLength(1);
    expect(body.series[0]).toEqual({
      day: '2026-06-01',
      original_microcents: 300,
      actual_microcents: 100,
      plugin_microcents: 25,
      billed_microcents: 125,
      savings_microcents: 200,
      requests: 5,
      unknown_cost_requests: 1,
      actual_costs_qualified: false,
    });
    expect(typeof body.series[0].savings_microcents).toBe('number');
    expect(typeof body.series[0].billed_microcents).toBe('number');
    expect(queryMock.mock.calls[0]?.[0]).toContain('plugin_cost_microcents');
    expect(queryMock.mock.calls[0]?.[0]).toContain('FILTER (WHERE actual_cost_known = true)');
    expect(queryMock.mock.calls[0]?.[0]).toContain('actual_cost_known = false');

    // team_id is the first bind param; month is expanded to a [start, end) range.
    const params = queryMock.mock.calls[0][1];
    expect(params[0]).toBe('org-1');
    expect(params).toHaveLength(3);
    expect(params[1]).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
    expect(params[2]).toBe(new Date(Date.UTC(2026, 6, 1)).toISOString());
  });

  it('parses the ClickHouse JSONEachRow branch and coerces quoted Int64s to numbers', async () => {
    cfg.clickhouseUrl = 'http://ch.test/';
    const lines = [
      JSON.stringify({
        day: '2026-06-01',
        // ClickHouse quotes 64-bit integers in JSON by default.
        original_microcents: '300000000',
        actual_microcents: '100000000',
        plugin_microcents: '5000000',
        billed_microcents: '105000000',
        savings_microcents: '200000000',
        requests: '5',
        unknown_cost_requests: '1',
      }),
      JSON.stringify({
        day: '2026-06-02',
        original_microcents: '0',
        actual_microcents: '0',
        plugin_microcents: '0',
        billed_microcents: '0',
        savings_microcents: '0',
        requests: '0',
        unknown_cost_requests: '0',
      }),
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(lines, { status: 200 })));

    const res = makeRes();
    await handleSavingsSeries(
      { url: '/admin/usage/savings-series?team_id=org-1&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.series).toHaveLength(2);
    expect(body.series[0]).toEqual({
      day: '2026-06-01',
      original_microcents: 300000000,
      actual_microcents: 100000000,
      plugin_microcents: 5000000,
      billed_microcents: 105000000,
      savings_microcents: 200000000,
      requests: 5,
      unknown_cost_requests: 1,
      actual_costs_qualified: false,
    });
    expect(typeof body.series[0].savings_microcents).toBe('number');
    expect(queryMock).not.toHaveBeenCalled(); // Postgres pool not touched
    const calledUrl = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).toContain('param_team_id=org-1');
    expect(new URL(calledUrl).searchParams.get('query')).toContain('countIf(actual_cost_known = 0)');
    expect(new URL(calledUrl).searchParams.get('query')).toContain('actual_cost_known = 1 AND savings_microcents > 0');
  });

  it('keeps the demo team on Postgres when ClickHouse is configured', async () => {
    cfg.clickhouseUrl = 'http://ch.test/';
    queryMock.mockResolvedValue({
      rows: [
        {
          day: '2026-06-01',
          original_microcents: 300,
          actual_microcents: 100,
          plugin_microcents: 0,
          billed_microcents: 100,
          savings_microcents: 200,
          requests: 5,
          unknown_cost_requests: 0,
        },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    const res = makeRes();
    await handleSavingsSeries(
      { url: '/admin/usage/savings-series?team_id=d0000000-0000-4000-8000-000000000001&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('postgres-demo');
    expect(body.series).toHaveLength(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
