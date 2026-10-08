import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('../db/pool.js', () => ({ getPool: () => ({ query: queryMock }) }));

import { handleUsageByIdentity } from './by-identity.js';

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

describe('handleUsageByIdentity', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('400s when team_id is missing', async () => {
    const res = makeRes();
    await handleUsageByIdentity(
      { url: '/admin/usage/by-identity?month=2026-06' } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe('team_id query parameter is required');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('400s when month is missing or malformed', async () => {
    const res = makeRes();
    await handleUsageByIdentity(
      { url: '/admin/usage/by-identity?team_id=org-1&month=2026-6' } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe('month query parameter must be in YYYY-MM format');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('floors savings at zero in the query (LAY-345 clamp-consistency)', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          identity_id: 'alice@example.com',
          total_input_tokens: 1000,
          total_output_tokens: 500,
          actual_cost_microcents: 100,
          plugin_cost_microcents: 10,
          billed_cost_microcents: 110,
          savings_microcents: 200,
          request_count: 3,
          unknown_cost_requests: 0,
        },
      ],
    });
    const res = makeRes();
    await handleUsageByIdentity(
      { url: '/admin/usage/by-identity?team_id=org-1&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const sql = queryMock.mock.calls[0]?.[0] as string;
    expect(sql).toContain('GREATEST(l.savings_microcents, 0)');
    expect(sql).toContain('FILTER (WHERE l.actual_cost_known = true)');
    expect(sql).toContain('l.actual_cost_known = false');
  });

  it('returns a team-scoped per-identity rollup that carries the savings field', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          identity_id: 'alice@example.com',
          total_input_tokens: 1000,
          total_output_tokens: 500,
          actual_cost_microcents: 100,
          plugin_cost_microcents: 10,
          billed_cost_microcents: 110,
          savings_microcents: 200,
          request_count: 3,
          unknown_cost_requests: 1,
        },
        {
          identity_id: 'bob@example.com',
          total_input_tokens: 200,
          total_output_tokens: 50,
          actual_cost_microcents: 40,
          plugin_cost_microcents: 0,
          billed_cost_microcents: 40,
          // A fallback-heavy identity: negative per-request savings summed
          // and floored, so the mock's Postgres GREATEST already yields 0.
          savings_microcents: 0,
          request_count: 1,
          unknown_cost_requests: 0,
        },
      ],
    });
    const res = makeRes();
    await handleUsageByIdentity(
      { url: '/admin/usage/by-identity?team_id=org-1&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.month).toBe('2026-06');
    expect(body.team_id).toBe('org-1');
    expect(body.records).toHaveLength(2);
    expect(body.records[0]).toEqual({
      identity_id: 'alice@example.com',
      total_input_tokens: 1000,
      total_output_tokens: 500,
      actual_cost_microcents: 100,
      plugin_cost_microcents: 10,
      billed_cost_microcents: 110,
      savings_microcents: 200,
      request_count: 3,
      unknown_cost_requests: 1,
      actual_costs_qualified: false,
    });
    expect(typeof body.records[0].savings_microcents).toBe('number');
    expect(body.records[1].savings_microcents).toBe(0);

    // team_id is the first bind param; month is expanded to a [start, end) range.
    const params = queryMock.mock.calls[0][1];
    expect(params[0]).toBe('org-1');
    expect(params).toHaveLength(3);
    expect(params[1]).toBe(new Date(Date.UTC(2026, 5, 1)).toISOString());
    expect(params[2]).toBe(new Date(Date.UTC(2026, 6, 1)).toISOString());
  });

  it('groups on the immutable logged snapshot; current key metadata is only a legacy fallback (AXI-8)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const res = makeRes();
    await handleUsageByIdentity(
      { url: '/admin/usage/by-identity?team_id=org-1&month=2026-06' } as never,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    // Strip comments so explanatory text can't mask the pinned clauses.
    const sql = (queryMock.mock.calls[0]?.[0] as string)
      .replace(/--[^\n]*/g, '')
      .replace(/\s+/g, ' ');
    // The snapshot arm of the COALESCE must NOT pass through NULLIF: the
    // writer stores the '' sentinel for key-without-identity requests, and
    // '' must block the metadata fallback (only genuine pre-migration NULLs
    // may fall back). The logged snapshot leads in both SELECT and GROUP BY,
    // so a later metadata edit cannot reattribute a snapshotted row.
    const snapshotFirst =
      "COALESCE(l.layer_identity_id, k.metadata->>'layer_identity_id')";
    expect(sql).toContain(`${snapshotFirst} AS identity_id`);
    expect(sql).toContain(`GROUP BY ${snapshotFirst}`);
    // Bare current-metadata grouping is gone from the projection and grouping.
    expect(sql).not.toContain("k.metadata->>'layer_identity_id' AS identity_id");
    expect(sql).not.toContain("GROUP BY k.metadata->>'layer_identity_id'");
    // Snapshotted rows must survive a missing key row (NULL api_key_id) or a
    // hard-deleted key: the fallback join can never eliminate the attribution
    // of record. k.team_id = l.team_id pins the fallback label to the same
    // tenant so a stale api_key_id can't borrow another tenant's identity.
    expect(sql).toContain('LEFT JOIN api_keys k ON k.id = l.api_key_id AND k.team_id = l.team_id');
    expect(sql).not.toContain('FROM request_logs l JOIN api_keys');
    // The OR must stay parenthesized: AND binds tighter than OR, so losing
    // the parens would lift the metadata predicate out of the team/window
    // conjuncts and leak other tenants' rows (fail-closed boundary).
    // NULLIF on the metadata arm stops ''/JSON-null metadata from forming a
    // phantom empty identity group (ClickHouse MV parity).
    expect(sql).toContain(
      "AND ( NULLIF(l.layer_identity_id, '') IS NOT NULL OR (l.layer_identity_id IS NULL AND NULLIF(k.metadata->>'layer_identity_id', '') IS NOT NULL) )",
    );
    // The old metadata-only predicate is fully gone, not anchored as the
    // trailing conjunct.
    expect(sql).not.toContain("k.metadata ? 'layer_identity_id'");
  });
});
