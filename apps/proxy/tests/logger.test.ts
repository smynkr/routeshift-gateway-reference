import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ingesterPush: vi.fn(),
  ingesterShutdown: vi.fn(async () => {}),
  pgPush: vi.fn(),
  pgShutdown: vi.fn(async () => {}),
  ClickHouseIngester: vi.fn(),
  PostgresWriter: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../src/logging/clickhouse.js', () => ({
  ClickHouseIngester: mocks.ClickHouseIngester,
}));

vi.mock('../src/logging/postgres-writer.js', () => ({
  PostgresWriter: mocks.PostgresWriter,
}));

describe('logger module', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(mocks.log);

    mocks.ClickHouseIngester.mockImplementation(() => ({
      push: mocks.ingesterPush,
      shutdown: mocks.ingesterShutdown,
      pendingCount: 9,
      droppedCount: 0,
    }));
    mocks.PostgresWriter.mockImplementation(() => ({
      push: mocks.pgPush,
      shutdown: mocks.pgShutdown,
      pendingCount: 3,
      droppedCount: 1,
    }));

    delete process.env.DATABASE_URL;
    delete process.env.CLICKHOUSE_URL;
  });

  it('logs to stdout when no backends are configured', async () => {
    const { logRequest } = await import('../src/logging/logger.js');
    logRequest({
      id: 'r1',
      timestamp: new Date().toISOString(),
      team_id: 'team_1',
      provider: 'openai',
      model_requested: 'gpt-4o',
      model_resolved: 'gpt-4o-mini',
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      original_cost_microcents: 10,
      actual_cost_microcents: 8,
      savings_microcents: 2,
      total_latency_ms: 100,
      ttft_ms: null,
      is_streaming: false,
      is_fallback: false,
      status_code: 200,
    });

    expect(mocks.log).toHaveBeenCalledTimes(1);
    expect(mocks.pgPush).not.toHaveBeenCalled();
    expect(mocks.ingesterPush).not.toHaveBeenCalled();
  });

  it('initializes postgres and clickhouse backends and maps ttft field', async () => {
    process.env.DATABASE_URL = 'postgres://db';
    process.env.CLICKHOUSE_URL = 'https://user:secret@clickhouse.local';
    const { initLogger, logRequest, shutdownLogger } = await import('../src/logging/logger.js');

    initLogger();
    expect(mocks.PostgresWriter).toHaveBeenCalledTimes(1);
    expect(mocks.ClickHouseIngester).toHaveBeenCalledWith('https://user:secret@clickhouse.local');
    expect(mocks.log).toHaveBeenCalledWith('ClickHouse logging enabled');
    expect(mocks.log.mock.calls.flat().join(' ')).not.toContain('secret');

    logRequest({
      id: 'r2',
      timestamp: new Date().toISOString(),
      team_id: 'team_1',
      provider: 'openai',
      model_requested: 'gpt-4o',
      model_resolved: 'gpt-4o-mini',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      original_cost_microcents: 100,
      actual_cost_microcents: 90,
      savings_microcents: 10,
      total_latency_ms: 200,
      ttft_ms: 42,
      is_streaming: true,
      is_fallback: false,
      status_code: 200,
    });

    expect(mocks.pgPush).toHaveBeenCalledTimes(1);
    expect(mocks.ingesterPush).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'r2',
        time_to_first_token_ms: 42,
      }),
    );

    await shutdownLogger();
    expect(mocks.pgShutdown).toHaveBeenCalledTimes(1);
    expect(mocks.ingesterShutdown).toHaveBeenCalledTimes(1);
  });
  it('preserves null versus measured zero reasoning telemetry in ClickHouse mappings', async () => {
    process.env.CLICKHOUSE_URL = 'https://clickhouse.local';
    const { initLogger, logRequest } = await import('../src/logging/logger.js');
    initLogger();

    const record = {
      timestamp: new Date().toISOString(),
      team_id: 'team_1',
      provider: 'openai',
      model_requested: 'gpt-4o',
      model_resolved: 'gpt-4o-mini',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      original_cost_microcents: 100,
      actual_cost_microcents: 90,
      actual_cost_known: true,
      savings_microcents: 10,
      total_latency_ms: 200,
      ttft_ms: 42,
      is_streaming: true,
      is_fallback: false,
      status_code: 200,
    } as const;

    logRequest({
      ...record,
      id: 'r-reasoning-null',
      reasoning_tokens: null,
      reasoning_cost_microcents: null,
    });
    logRequest({
      ...record,
      id: 'r-reasoning-zero',
      reasoning_tokens: 0,
      reasoning_cost_microcents: 0,
    });

    expect(mocks.ingesterPush).toHaveBeenNthCalledWith(1, expect.objectContaining({
      reasoning_tokens: null,
      reasoning_cost_microcents: null,
    }));
    expect(mocks.ingesterPush).toHaveBeenNthCalledWith(2, expect.objectContaining({
      reasoning_tokens: 0,
      reasoning_cost_microcents: 0,
    }));
  });


  it('serializes ClickHouse turn-signal fields to schema-compatible values', async () => {
    process.env.CLICKHOUSE_URL = 'https://clickhouse.local';
    const { initLogger, logRequest } = await import('../src/logging/logger.js');

    initLogger();
    logRequest({
      id: 'r-turn-signals',
      timestamp: new Date().toISOString(),
      team_id: 'team_1',
      provider: 'openai',
      model_requested: 'gpt-4o',
      model_resolved: 'gpt-4o-mini',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      original_cost_microcents: 100,
      actual_cost_microcents: 90,
      savings_microcents: 10,
      total_latency_ms: 200,
      ttft_ms: 42,
      is_streaming: true,
      is_fallback: false,
      status_code: 200,
      edited_paths: ['a.ts', 'b.ts'],
      had_bash: true,
      rate_limited: true,
    });

    expect(mocks.ingesterPush).toHaveBeenCalledWith(
      expect.objectContaining({
        edited_paths: '["a.ts","b.ts"]',
        had_bash: 1,
        rate_limited: 1,
      }),
    );
  });

  it('keeps unknown-cost evidence in both the top-level ClickHouse flag and nested fallback JSON', async () => {
    process.env.DATABASE_URL = 'postgres://db';
    process.env.CLICKHOUSE_URL = 'https://clickhouse.local';
    const { initLogger, logRequest } = await import('../src/logging/logger.js');

    initLogger();
    logRequest({
      id: 'r-unknown-cost', timestamp: new Date().toISOString(), team_id: 'team_1',
      provider: 'openai', model_requested: 'gpt-4o', model_resolved: 'gpt-4o-mini',
      input_tokens: 1, output_tokens: 0, total_tokens: 1, original_cost_microcents: 10,
      actual_cost_microcents: 0, actual_cost_known: false, savings_microcents: 0,
      total_latency_ms: 100, ttft_ms: null, is_streaming: false, is_fallback: true, status_code: 502,
      fallback_attempts: [{ provider: 'openai', model: 'gpt-4o-mini', error: 'parse failed', actual_cost_known: false }],
    });

    expect(mocks.pgPush).toHaveBeenCalledWith(expect.objectContaining({ actual_cost_known: false }));
    expect(mocks.ingesterPush).toHaveBeenCalledWith(expect.objectContaining({
      fallback_attempts: JSON.stringify([
        { provider: 'openai', model: 'gpt-4o-mini', error: 'parse failed', actual_cost_known: false },
      ]),
    }));
    expect(mocks.ingesterPush.mock.calls[0][0]).toHaveProperty('actual_cost_known', 0);
  });

  it('defaults omitted ClickHouse turn-signal fields without crashing', async () => {
    process.env.CLICKHOUSE_URL = 'https://clickhouse.local';
    const { initLogger, logRequest } = await import('../src/logging/logger.js');

    initLogger();
    expect(() =>
      logRequest({
        id: 'r-no-turn-signals',
        timestamp: new Date().toISOString(),
        team_id: 'team_1',
        provider: 'openai',
        model_requested: 'gpt-4o',
        model_resolved: 'gpt-4o-mini',
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        original_cost_microcents: 100,
        actual_cost_microcents: 90,
        savings_microcents: 10,
        total_latency_ms: 200,
        ttft_ms: null,
        is_streaming: false,
        is_fallback: false,
        status_code: 200,
      }),
    ).not.toThrow();

    expect(mocks.ingesterPush).toHaveBeenCalledWith(
      expect.objectContaining({
        edited_paths: '[]',
        had_bash: 0,
        rate_limited: 0,
      }),
    );
  });

  it('getLoggerStats: null for unconfigured sinks, populated after init (RSH-65)', async () => {
    const { getLoggerStats, initLogger, shutdownLogger } = await import('../src/logging/logger.js');

    // Nothing configured yet → both sinks null.
    expect(getLoggerStats()).toEqual({ postgres: null, clickhouse: null });

    process.env.DATABASE_URL = 'postgres://db';
    process.env.CLICKHOUSE_URL = 'https://clickhouse.local';
    initLogger();

    // Reads pendingCount/droppedCount off each live writer (mock values above).
    expect(getLoggerStats()).toEqual({
      postgres: { pending: 3, dropped: 1 },
      clickhouse: { pending: 9, dropped: 0 },
    });

    await shutdownLogger();
  });
});
