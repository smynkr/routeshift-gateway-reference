/**
 * RSH-136: admin auto-route quality_derank opt-in surface + verdict
 * persistence/aggregation SQL (pool mocked — SQL text and parameter shapes
 * are the contract under test).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = { query: vi.fn() };
vi.mock('../src/db/pool.js', () => ({ getPool: () => ({ query: mocks.query }) }));

import {
  getAutoRouteSettings,
  handleUpdateAutoRouteSettings,
  invalidateAutoRouteCache,
} from '../src/admin/auto-route.js';
import { insertQualityVerdicts, getQualityVerdictSignals, invalidateQualityVerdictSignalsCache, retainQualityVerdicts } from '../src/db/quality-verdicts.js';

function fakeResponse() {
  const state = { statusCode: 0, body: '' };
  return {
    writeHead: (code: number) => { state.statusCode = code; },
    end: (body: string) => { state.body = body; },
    state,
  } as never;
}

beforeEach(() => {
  mocks.query.mockReset();
  invalidateAutoRouteCache('team_1');
  invalidateAutoRouteCache('team_2');
});

describe('admin auto-route settings (RSH-136 opt-in)', () => {
  it('defaults quality_derank to false when no row exists', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const settings = await getAutoRouteSettings('team_1');
    expect(settings.quality_derank).toBe(false);
  });

  it('reads quality_derank from the stored row', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ enabled: true, strategy: 'balanced', max_fallbacks: 2, quality_derank: true }],
    });
    const settings = await getAutoRouteSettings('team_1');
    expect(settings.quality_derank).toBe(true);
  });

  it('writes quality_derank and PRESERVES it when absent (matches dashboard semantics)', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }); // upsert
    mocks.query.mockResolvedValueOnce({ rows: [{ quality_derank: false }] }); // effective read-back
    const res = fakeResponse() as { writeHead: (c: number) => void; end: (b: string) => void };
    const noFlagBody = JSON.stringify({ enabled: true, strategy: 'balanced', max_fallbacks: 2 });
    const req = {
      url: '/admin/auto-route?team_id=team_1',
      headers: {},
      method: 'POST',
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(noFlagBody); },
    } as never;
    await handleUpdateAutoRouteSettings(req, res);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('quality_derank = COALESCE($5, team_auto_route_settings.quality_derank)');
    expect(params[4]).toBeNull(); // absent → preserve sentinel

    mocks.query.mockClear();
    mocks.query.mockResolvedValueOnce({ rows: [] }); // upsert
    mocks.query.mockResolvedValueOnce({ rows: [{ quality_derank: true }] }); // effective read-back
    const flaggedBody = JSON.stringify({ enabled: true, strategy: 'balanced', max_fallbacks: 2, quality_derank: true });
    const flaggedReq = {
      url: '/admin/auto-route?team_id=team_1',
      headers: {},
      method: 'POST',
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(flaggedBody); },
    } as never;
    const res2 = fakeResponse() as { writeHead: (c: number) => void; end: (b: string) => void };
    await handleUpdateAutoRouteSettings(flaggedReq, res2);
    const [, params2] = mocks.query.mock.calls[0];
    expect(params2[4]).toBe(true);
  });
});

describe('quality verdict persistence (RSH-136)', () => {
  it('inserts one sanitized row per audit entry with a 8-placeholder shape', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await insertQualityVerdicts('req-1', [
      {
        attempt_index: 0, provider: 'openai', model: 'gpt-5.5', outcome: 'verified',
        reason_code: null, check_index: null, status_code: 200,
        input_tokens: 10, output_tokens: 20, actual_cost_microcents: 30,
        actual_cost_known: true, latency_ms: 100, circuit_failure: false,
      },
      {
        attempt_index: 1, provider: 'anthropic', model: 'claude-opus-4-8', outcome: 'quality_rejected',
        reason_code: 'quality_gate_nonempty_content', check_index: 0, status_code: 200,
        input_tokens: 10, output_tokens: 5, actual_cost_microcents: 15,
        actual_cost_known: true, latency_ms: 200, circuit_failure: false,
      },
      {
        attempt_index: 2, provider: 'anthropic', model: 'claude-opus-4-8', outcome: 'retryable_http',
        reason_code: null, check_index: null, status_code: 429,
        input_tokens: 0, output_tokens: 0, actual_cost_microcents: 0,
        actual_cost_known: true, latency_ms: 50, circuit_failure: false,
      },
      {
        attempt_index: 3, provider: 'google', model: 'gemini-3.1-pro', outcome: 'transport_error',
        reason_code: 'upstream_connection_failed', check_index: null, status_code: null,
        input_tokens: 0, output_tokens: 0, actual_cost_microcents: 0,
        actual_cost_known: false, latency_ms: 60, circuit_failure: false,
      },
    ]);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO quality_verdicts');
    expect(sql).toContain('ON CONFLICT (request_id, attempt_index) DO NOTHING');
    expect(params).toContain('req-1');
    expect(params).toContain('verified');
    expect(params).toContain('quality_gate_nonempty_content');
    // EVERY AttemptOutcome kind persists — a retryable/transport row must not
    // violate the CHECK and drop the whole batch (regression for the
    // migration-062 constraint gap)
    expect(params).toContain('retryable_http');
    expect(params).toContain('transport_error');
    // row 1 (quality_rejected) check_index lands at offset 7 + 8 = 15
    expect(params[15]).toBe(0);
  });

  it('no-ops on an empty audit', async () => {
    await insertQualityVerdicts('req-2', []);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('caches the aggregation and honors the invalidation seam', async () => {
    invalidateQualityVerdictSignalsCache();
    mocks.query.mockResolvedValueOnce({ rows: [{ provider: 'openai', model: 'gpt-5.5', verified: '8', rejected: '2' }] });
    const first = await getQualityVerdictSignals(new Date('2026-08-03T00:00:00Z'));
    // second call within the TTL must NOT hit the pool again
    const second = await getQualityVerdictSignals(new Date('2026-08-03T00:00:00Z'));
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    invalidateQualityVerdictSignalsCache();
  });

  it('retains in bounded batches (parameterized DELETE)', async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 5 }).mockResolvedValueOnce({ rowCount: 0 });
    await retainQualityVerdicts(90);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM quality_verdicts');
    expect(sql).toContain('LIMIT $2');
    expect(params[0]).toBe(90);
    expect(params[1]).toBe(10_000);
    expect(mocks.query).toHaveBeenCalledTimes(2); // stops when a batch deletes 0 rows
  });

  it('aggregates verified vs quality_rejected per provider:model, excluding terminal', async () => {
    invalidateQualityVerdictSignalsCache();
    mocks.query.mockResolvedValueOnce({
      rows: [
        { provider: 'openai', model: 'gpt-5.5', verified: '8', rejected: '2' },
        { provider: 'anthropic', model: 'claude-opus-4-8', verified: '1', rejected: '9' },
      ],
    });
    const signals = await getQualityVerdictSignals(new Date('2026-08-03T00:00:00Z'));
    expect(signals).toEqual([
      { provider: 'openai', model: 'gpt-5.5', verified: 8, rejected: 2 },
      { provider: 'anthropic', model: 'claude-opus-4-8', verified: 1, rejected: 9 },
    ]);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(sql).toContain("outcome = 'verified'");
    expect(sql).toContain("outcome = 'quality_rejected'");
    expect(sql).toContain('created_at >= $1');
    expect(params[0]).toEqual(new Date('2026-08-03T00:00:00Z'));
  });
});
