import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const mockQuery = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { handleSessionsWindow, encodeCursor } from '../src/admin/sessions.js';

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function makeReq(url: string): IncomingMessage {
  return { url, headers: {}, method: 'GET' } as unknown as IncomingMessage;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, headers: {}, body: '' };
  const res = {
    writeHead: (code: number, headers?: Record<string, string>) => {
      captured.statusCode = code;
      if (headers) Object.assign(captured.headers, headers);
    },
    end: (body?: string) => {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

const sampleRow = {
  session_id: 'sess_a',
  team_id: 'team_1',
  edit_turns: 4,
  retry_turns: 1,
  one_shot_rate: '0.7500',
  primary_model: 'claude-sonnet-4-6',
  total_cost_microcents: '12500',
  billed_cost_microcents: '13000',
  unknown_cost_requests: 1,
  first_request_at: new Date('2026-04-29T00:00:00Z'),
  last_request_at: new Date('2026-04-29T00:30:00Z'),
};

describe('handleSessionsWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('400s when from is missing or invalid', async () => {
    const { res, captured } = makeRes();
    await handleSessionsWindow(makeReq('/admin/sessions/window?to=2026-04-29T00:00:00Z&team_id=team_1'), res);
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error.message).toMatch(/from/i);
  });

  it('400s when to is missing or invalid', async () => {
    const { res, captured } = makeRes();
    await handleSessionsWindow(makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&team_id=team_1'), res);
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error.message).toMatch(/to/i);
  });

  it('400s when from >= to', async () => {
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T01:00:00Z&to=2026-04-29T00:00:00Z&team_id=team_1'),
      res,
    );
    expect(captured.statusCode).toBe(400);
  });

  it('400s when window exceeds 7 days', async () => {
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-01T00:00:00Z&to=2026-04-15T00:00:00Z&team_id=team_1'),
      res,
    );
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error.message).toMatch(/7 days/i);
  });

  it('queries session_metrics with from/to bounds and returns sessions', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRow] });
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&team_id=team_1'),
      res,
    );
    expect(captured.statusCode).toBe(200);
    const body = JSON.parse(captured.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].session_id).toBe('sess_a');
    expect(body.sessions[0].one_shot_rate).toBe(0.75);
    expect(body.sessions[0].total_cost_microcents).toBe('12500');
    expect(body.sessions[0].billed_cost_microcents).toBe('13000');
    expect(body.sessions[0].unknown_cost_requests).toBe(1);
    expect(body.next_cursor).toBeNull();

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT[\s\S]*unknown_cost_requests[\s\S]*FROM session_metrics/);
    expect(sql).toMatch(/FROM session_metrics/);
    expect(sql).toMatch(/last_request_at >= \$1/);
    expect(sql).toMatch(/last_request_at < \$2/);
    expect(sql).toMatch(/team_id = \$3/);
    expect(params[0]).toBeInstanceOf(Date);
    expect(params[1]).toBeInstanceOf(Date);
    expect(params[2]).toBe('team_1');
  });

  it('honors limit parameter (clamped to 1..1000, default 200)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { res } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&limit=50&team_id=team_1'),
      res,
    );
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT \$\d/);
    // limit=50 → query asks for 51 (n+1 to detect more)
    expect(params[params.length - 1]).toBe(51);
  });

  it('clamps oversized limit', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { res } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&limit=99999&team_id=team_1'),
      res,
    );
    const [, params] = mockQuery.mock.calls[0];
    expect(params[params.length - 1]).toBe(1001);
  });

  it('returns next_cursor when more rows exist', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      ...sampleRow,
      session_id: `sess_${i}`,
      last_request_at: new Date(`2026-04-29T00:${String(i).padStart(2, '0')}:00Z`),
    }));
    mockQuery.mockResolvedValueOnce({ rows });
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&limit=50&team_id=team_1'),
      res,
    );
    const body = JSON.parse(captured.body);
    expect(body.sessions).toHaveLength(50);
    expect(body.next_cursor).not.toBeNull();
    // Cursor decodes back to the 50th row's (last_request_at, session_id)
    const decoded = JSON.parse(Buffer.from(body.next_cursor, 'base64url').toString('utf8'));
    expect(decoded.session_id).toBe('sess_49');
  });

  it('applies cursor as a (last_request_at, session_id) tuple comparison', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const cursor = encodeCursor(new Date('2026-04-29T00:15:00Z'), 'sess_x');
    const { res } = makeRes();
    await handleSessionsWindow(
      makeReq(
        `/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&cursor=${cursor}&team_id=team_1`,
      ),
      res,
    );
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/\(last_request_at, session_id\) > \(\$\d, \$\d\)/);
    expect(params).toContain('sess_x');
  });

  it('400s on malformed cursor', async () => {
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq(
        '/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&cursor=not-base64&team_id=team_1',
      ),
      res,
    );
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error.message).toMatch(/cursor/i);
  });

  it('passes through one_shot_rate=null for sessions with no edit turns', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...sampleRow, edit_turns: 0, retry_turns: 0, one_shot_rate: null }],
    });
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&team_id=team_1'),
      res,
    );
    const body = JSON.parse(captured.body);
    expect(body.sessions[0].one_shot_rate).toBeNull();
  });

  it('orders by (last_request_at ASC, session_id ASC) for stable pagination', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { res } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&team_id=team_1'),
      res,
    );
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY last_request_at ASC, session_id ASC/);
  });

  it('400s when team_id is missing', async () => {
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z'),
      res,
    );
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error.message).toMatch(/team_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('400s when team_id is empty', async () => {
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&team_id='),
      res,
    );
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error.message).toMatch(/team_id/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('400s when team_id is the wildcard', async () => {
    const { res, captured } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&team_id=*'),
      res,
    );
    expect(captured.statusCode).toBe(400);
    expect(JSON.parse(captured.body).error.message).toMatch(/concrete/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('binds the requested team_id into the SQL WHERE (no cross-tenant read)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const { res } = makeRes();
    await handleSessionsWindow(
      makeReq('/admin/sessions/window?from=2026-04-29T00:00:00Z&to=2026-04-29T23:59:59Z&team_id=team_1'),
      res,
    );
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/team_id = \$3/);
    expect(params[2]).toBe('team_1');
    expect(sql).not.toContain("team_id = 'team_1'");
  });
});

describe('encodeCursor / decodeCursor symmetry', () => {
  it('round-trips a (Date, session_id) tuple through base64url', async () => {
    const ts = new Date('2026-04-29T00:30:00Z');
    const cursor = encodeCursor(ts, 'sess_round_trip');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    expect(new Date(decoded.last_request_at).getTime()).toBe(ts.getTime());
    expect(decoded.session_id).toBe('sess_round_trip');
  });
});
