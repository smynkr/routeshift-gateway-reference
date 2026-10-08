import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { PostgresWriter } from '../src/logging/postgres-writer.js';
import type { RequestLogRecord } from '../src/logging/logger.js';

function makeRecord(id: string): RequestLogRecord {
  return {
    id,
    timestamp: new Date().toISOString(),
    team_id: 'team_a',
    provider: 'openai',
    model_requested: 'gpt-4.1',
    model_resolved: 'gpt-4.1',
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    original_cost_microcents: 1000,
    actual_cost_microcents: 800,
    actual_cost_known: true,
    savings_microcents: 200,
    total_latency_ms: 300,
    ttft_ms: 50,
    is_streaming: true,
    is_fallback: false,
    status_code: 200,
  };
}

describe('PostgresWriter', () => {
  let writer: PostgresWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [] });
    // Large maxSize to avoid auto-flush, long interval to control flush timing
    writer = new PostgresWriter(100, 60_000);
  });

  afterEach(async () => {
    await writer.shutdown();
    vi.useRealTimers();
  });

  it('push: adds to buffer', () => {
    writer.push(makeRecord('rec-1'));
    writer.push(makeRecord('rec-2'));
    // No flush should have been triggered since buffer (2) < maxSize (100)
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('flush: batch inserts records and clears buffer', async () => {
    writer.push(makeRecord('rec-1'));
    writer.push(makeRecord('rec-2'));

    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO request_logs');
    expect(values).toHaveLength(2 * 39); // 2 records, 39 columns each

    // Flushing again should be a no-op (buffer was cleared)
    mockQuery.mockClear();
    await writer.flush();
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it('flush: preserves measured zero reasoning telemetry in nullable columns', async () => {
    writer.push({
      ...makeRecord('rec-reasoning-zero'),
      reasoning_tokens: 0,
      reasoning_cost_microcents: 0,
    });

    await writer.flush();

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('reasoning_tokens');
    expect(sql).toContain('reasoning_cost_microcents');
    expect(values[37]).toBe(0);
    expect(values[38]).toBe(0);
  });


  it('flush failure: re-queues batch', async () => {
    writer.push(makeRecord('rec-1'));

    mockQuery.mockRejectedValueOnce(new Error('DB connection failed'));
    await writer.flush();

    // The batch should have been re-queued
    // Now flush again successfully
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [sql] = mockQuery.mock.calls[1];
    expect(sql).toContain('INSERT INTO request_logs');
  });

  it('buffer cap: push drops oldest and accounts the drop, staying bounded', async () => {
    // Tiny injected cap + huge maxSize → exercise the cap without auto-flush.
    const w = new PostgresWriter(100_000, 60_000, 5);
    for (let i = 0; i < 8; i++) w.push(makeRecord(`rec-${i}`));
    expect(w.pendingCount).toBe(5); // bounded at the cap
    expect(w.droppedCount).toBe(3); // 3 oldest dropped AND accounted
    await w.shutdown();
  });

  it('failure re-queue stays bounded and accounts forced drops (cap holds on the catch path)', async () => {
    const w = new PostgresWriter(100_000, 60_000, 5); // cap 5, high maxSize
    mockQuery.mockRejectedValue(new Error('DB down'));

    for (let i = 0; i < 5; i++) w.push(makeRecord(`b-${i}`)); // buffer = 5
    const flushing = w.flush(); // takes batch=5, empties buffer, query rejects (awaiting)
    for (let i = 0; i < 4; i++) w.push(makeRecord(`n-${i}`)); // newcomers arrive in-flight → buffer=4
    await flushing; // catch: 5 re-queued in front of 4 = 9 → drop 4 oldest, back to cap

    expect(w.pendingCount).toBe(5); // bounded despite batch + newcomers > cap (not ~2x)
    expect(w.droppedCount).toBe(4); // forced re-queue drops are accounted
    await w.shutdown();
  });

  it('shutdown: flushes remaining records', async () => {
    writer.push(makeRecord('rec-1'));
    writer.push(makeRecord('rec-2'));
    writer.push(makeRecord('rec-3'));

    await writer.shutdown();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO request_logs');
  });

  it('request_kind: defaults to "chat" when omitted', async () => {
    writer.push(makeRecord('rec-1')); // no request_kind set

    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('request_kind');
    expect(values[32]).toBe('chat');
  });

  it('request_kind: passes "embedding" when explicitly set', async () => {
    const record = { ...makeRecord('rec-2'), request_kind: 'embedding' as const };
    writer.push(record);

    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('request_kind');
    expect(values[32]).toBe('embedding');
  });

  it('fallback-success persistence: stores exact fallback attempts as JSONB', async () => {
    const fallbackAttempts = [
      { provider: 'openai', model: 'gpt-4.1', error: 'HTTP 503' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', error: 'Context window too small' },
    ];
    writer.push({
      ...makeRecord('rec-fallback-success'),
      provider: 'anthropic',
      model_resolved: 'claude-sonnet-4-6',
      is_fallback: true,
      fallback_attempts: fallbackAttempts,
    });

    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('fallback_attempts');
    expect(JSON.parse(values[33] as string)).toEqual(fallbackAttempts);
  });

  it('fallback-exhausted persistence: stores exact exhausted attempt reasons', async () => {
    const fallbackAttempts = [
      { provider: 'openai', model: 'gpt-4.1', error: 'Network error: socket hang up' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', error: 'No provider key configured' },
      { provider: 'google', model: 'gemini-2.5-pro', error: 'Retry budget exhausted (max_retries)' },
    ];
    writer.push({
      ...makeRecord('rec-fallback-exhausted'),
      status_code: 503,
      error_type: 'fallback_exhausted',
      fallback_attempts: fallbackAttempts,
    });

    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('fallback_attempts');
    expect(values[22]).toBe(503);
    expect(values[23]).toBe('fallback_exhausted');
    expect(JSON.parse(values[33] as string)).toEqual(fallbackAttempts);
  });

  it('persists top-level actual-cost knownness for terminal unknown-cost audits', async () => {
    writer.push({ ...makeRecord('rec-unknown-cost'), actual_cost_known: false });
    await writer.flush();

    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('actual_cost_known');
    expect(values[15]).toBe(false);
  });

  it('plugin-warning persistence: stores exact plugin skip and failure reasons as JSONB', async () => {
    const pluginWarnings = [
      {
        plugin: 'web',
        code: 'plugin_backend_not_configured',
        reason: 'No backend configured for plugin web',
        message: 'Plugin web skipped: No backend configured for plugin web',
      },
    ];
    writer.push({
      ...makeRecord('rec-plugin-warning'),
      plugin_warnings: pluginWarnings,
    });

    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('plugin_warnings');
    expect(JSON.parse(values[34] as string)).toEqual(pluginWarnings);
  });

  it("persists the layer_identity_id snapshot and defaults it to '' when absent (AXI-8)", async () => {
    writer.push({ ...makeRecord('rec-ident'), layer_identity_id: 'alice@example.com' });
    writer.push(makeRecord('rec-no-ident'));

    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, values] = mockQuery.mock.calls[0];
    expect(sql).toContain('layer_identity_id');
    // Trailing column: record 1 carries the snapshot; record 2 stores the ''
    // "known unattributed" sentinel (ClickHouse parity), NOT NULL — so a
    // post-migration row can never fall back to CURRENT key metadata and be
    // reattributed by a later metadata edit. NULL is reserved for
    // pre-migration rows, where the bounded legacy fallback applies.
    expect(values[36]).toBe('alice@example.com');
    expect(values[39 + 36]).toBe('');
  });

  it('persists a separate plugin fee and one sanitized audit row per plugin execution', async () => {
    writer.push({
      ...makeRecord('rec-plugin-run'),
      plugin_cost_microcents: 500_000,
      plugin_runs: [{
        plugin: 'web',
        status: 'ok',
        costMicrocents: 500_000,
        latencyMs: 42,
        detail: 'plugin_backend_failed',
      }],
    });

    await writer.flush();

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const [requestSql, requestValues] = mockQuery.mock.calls[0];
    expect(requestSql).toContain('plugin_cost_microcents');
    expect(requestValues[16]).toBe(500_000);
    const [runSql, runValues] = mockQuery.mock.calls[1];
    expect(runSql).toContain('INSERT INTO plugin_runs');
    expect(runSql).toContain('ON CONFLICT (request_id, plugin_id) DO NOTHING');
    expect(runValues).toEqual([
      'prun_rec-plugin-run_web',
      'rec-plugin-run',
      'team_a',
      'web',
      'ok',
      500_000,
      42,
      'plugin_backend_failed',
    ]);
  });

  it('drops an unsafe plugin audit detail instead of persisting backend text', async () => {
    writer.push({
      ...makeRecord('rec-plugin-detail'),
      plugin_runs: [{
        plugin: 'web',
        status: 'warning',
        costMicrocents: 0,
        latencyMs: 3,
        detail: 'backend body: secret=do-not-store' as never,
      }],
    });

    await writer.flush();

    const [, runValues] = mockQuery.mock.calls[1];
    expect(runValues[7]).toBeNull();
  });
});
