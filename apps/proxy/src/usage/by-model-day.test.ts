import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: queryMock }) }));
// Mutable config mock so individual tests can flip the ClickHouse branch on/off.
const cfg = vi.hoisted(() => ({ clickhouseUrl: undefined as string | undefined }));
vi.mock('../config.js', () => ({ config: cfg }));

import { handleByModelDay } from './by-model-day.js';

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

describe('handleByModelDay', () => {
  beforeEach(() => {
    queryMock.mockReset();
    cfg.clickhouseUrl = undefined; // default: Postgres branch
  });
  afterEach(() => vi.unstubAllGlobals());

  it('400s when team_id is missing', async () => {
    const res = makeRes();
    await handleByModelDay(
      { url: '/admin/usage/by-model-day?month=2026-06' } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('400s when month is malformed', async () => {
    const res = makeRes();
    await handleByModelDay(
      { url: '/admin/usage/by-model-day?team_id=org-1&month=nope' } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns team-scoped per-model-day records with numeric tokens + cost (Postgres)', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          day: '2026-06-01',
          model: 'claude-opus-4',
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          actual_cost_microcents: 100_000_000,
          plugin_cost_microcents: 5_000_000,
          billed_cost_microcents: 105_000_000,
          request_count: 3,
          unknown_cost_requests: 1,
        },
      ],
    });
    const res = makeRes();
    await handleByModelDay(
      { url: '/admin/usage/by-model-day?team_id=org-1&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.month).toBe('2026-06');
    expect(body.team_id).toBe('org-1');
    expect(body.records[0]).toEqual({
      day: '2026-06-01',
      model: 'claude-opus-4',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      actual_cost_microcents: 100_000_000,
      plugin_cost_microcents: 5_000_000,
      billed_cost_microcents: 105_000_000,
      request_count: 3,
      unknown_cost_requests: 1,
      actual_costs_qualified: false,
    });
    expect(typeof body.records[0].actual_cost_microcents).toBe('number');
    expect(typeof body.records[0].billed_cost_microcents).toBe('number');
    expect(queryMock.mock.calls[0]?.[0]).toContain('plugin_cost_microcents');
    expect(queryMock.mock.calls[0]?.[0]).toContain('billed_cost_microcents');
    expect(queryMock.mock.calls[0]?.[0]).toContain('actual_cost_known = false');

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
        model: 'claude-opus-4',
        input_tokens: '10',
        output_tokens: '5',
        total_tokens: '15',
        actual_cost_microcents: '100000000',
        plugin_cost_microcents: '5000000',
        billed_cost_microcents: '105000000',
        request_count: '3',
        unknown_cost_requests: '0',
      }),
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(lines, { status: 200 })));

    const res = makeRes();
    await handleByModelDay(
      { url: '/admin/usage/by-model-day?team_id=org-1&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.records[0]).toEqual({
      day: '2026-06-01',
      model: 'claude-opus-4',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      actual_cost_microcents: 100000000,
      plugin_cost_microcents: 5000000,
      billed_cost_microcents: 105000000,
      request_count: 3,
      unknown_cost_requests: 0,
      actual_costs_qualified: true,
    });
    expect(typeof body.records[0].actual_cost_microcents).toBe('number');
    expect(queryMock).not.toHaveBeenCalled(); // Postgres pool not touched
    const calledUrl = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    expect(calledUrl).toContain('param_team_id=org-1');
    expect(new URL(calledUrl).searchParams.get('query')).toContain('countIf(actual_cost_known = 0)');
  });

  it('keeps the demo team on Postgres when ClickHouse is configured', async () => {
    cfg.clickhouseUrl = 'http://ch.test/';
    queryMock.mockResolvedValue({
      rows: [
        {
          day: '2026-06-01',
          model: 'claude-opus-4',
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          actual_cost_microcents: 100_000_000,
          plugin_cost_microcents: 0,
          billed_cost_microcents: 100_000_000,
          request_count: 3,
          unknown_cost_requests: 0,
        },
      ],
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    const res = makeRes();
    await handleByModelDay(
      { url: '/admin/usage/by-model-day?team_id=d0000000-0000-4000-8000-000000000001&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.source).toBe('postgres-demo');
    expect(body.records).toHaveLength(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
