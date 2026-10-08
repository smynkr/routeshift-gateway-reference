import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: queryMock }) }));

import { handleOptimizeFindings } from './findings-endpoint.js';

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

describe('handleOptimizeFindings', () => {
  beforeEach(() => queryMock.mockReset());

  it('400s when team_id is missing', async () => {
    const res = makeRes();
    await handleOptimizeFindings({ url: '/admin/optimize/findings' } as never, res as never);
    expect(res.statusCode).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns team-scoped findings with numeric savings', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          id: 'f1',
          rule_id: 'low-cache-hit',
          severity: 'high',
          estimated_savings_microcents: '500000000',
          body_md: 'b',
          fix_md: 'f',
          status: 'open',
          first_seen_at: 't1',
          last_seen_at: 't2',
        },
      ],
    });
    const teamId = 'team_ab12cd34';
    const res = makeRes();
    await handleOptimizeFindings({ url: `/admin/optimize/findings?team_id=${teamId}` } as never, res as never);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.team_id).toBe(teamId);
    expect(body.findings[0].estimated_savings_microcents).toBe(500_000_000);
    expect(typeof body.findings[0].estimated_savings_microcents).toBe('number');
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).toMatch(/f\.estimated_savings_microcents DESC/);
    expect(sql).not.toContain('::uuid');
    expect(queryMock.mock.calls[0][1]).toEqual([teamId]);
  });

  it('accepts non-uuid self-serve team ids', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await handleOptimizeFindings({ url: '/admin/optimize/findings?team_id=team_selfserve' } as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(queryMock.mock.calls[0][1]).toEqual(['team_selfserve']);
  });

  it('omits the open-only filter when status=all', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const res = makeRes();
    const teamId = '11111111-1111-1111-1111-111111111111';
    await handleOptimizeFindings({ url: `/admin/optimize/findings?team_id=${teamId}&status=all` } as never, res as never);
    expect(res.statusCode).toBe(200);
    const sql = queryMock.mock.calls[0][0] as string;
    expect(sql).not.toContain("status = 'open'");
  });
});
