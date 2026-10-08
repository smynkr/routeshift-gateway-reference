import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runMigrations: vi.fn(async () => {}),
  applyDevSeed: vi.fn(async () => {}),
  ensureClickHouseRequestLogColumns: vi.fn(async () => {}),
  assertPostgresRequestLogSchema: vi.fn(async () => {}),
  assertPostgresBudgetLedgerSchema: vi.fn(async () => {}),
  initLogger: vi.fn(),
  startSavingsReporter: vi.fn(),
  startAutoTopUpWorker: vi.fn(),
  startPendingHoldReconciliationWorker: vi.fn(),
  startSessionAggregator: vi.fn(),
  startYieldCorrelator: vi.fn(),
  startOptimizeEngine: vi.fn(),
  startOrphanKeySweeper: vi.fn(),
  startSsoSweeper: vi.fn(),
  config: { databaseUrl: 'postgres://example', clickhouseUrl: undefined as string | undefined, port: 0 },
}));

vi.mock('../src/config.js', () => ({ config: mocks.config }));
vi.mock('../src/db/migrate.js', () => ({
  runMigrations: mocks.runMigrations,
  applyDevSeed: mocks.applyDevSeed,
}));
vi.mock('../src/db/clickhouse-schema-apply.js', () => ({
  ensureClickHouseRequestLogColumns: mocks.ensureClickHouseRequestLogColumns,
}));
vi.mock('../src/db/postgres-schema-guard.js', () => ({
  assertPostgresRequestLogSchema: mocks.assertPostgresRequestLogSchema,
  assertPostgresBudgetLedgerSchema: mocks.assertPostgresBudgetLedgerSchema,
}));
vi.mock('../src/logging/logger.js', () => ({ initLogger: mocks.initLogger }));
vi.mock('../src/billing/savings-reporter.js', () => ({ startSavingsReporter: mocks.startSavingsReporter }));
vi.mock('../src/billing/auto-topup-worker.js', () => ({ startAutoTopUpWorker: mocks.startAutoTopUpWorker }));
vi.mock('../src/billing/pending-hold-reconciliation-worker.js', () => ({
  startPendingHoldReconciliationWorker: mocks.startPendingHoldReconciliationWorker,
}));
vi.mock('../src/observability/session-aggregator.js', () => ({ startSessionAggregator: mocks.startSessionAggregator }));
vi.mock('../src/observability/yield-correlator.js', () => ({ startYieldCorrelator: mocks.startYieldCorrelator }));
vi.mock('../src/optimize/engine.js', () => ({ startOptimizeEngine: mocks.startOptimizeEngine }));
vi.mock('../src/oauth/orphan-key-sweeper.js', () => ({ startOrphanKeySweeper: mocks.startOrphanKeySweeper }));
vi.mock('../src/oauth/sso-sweeper.js', () => ({ startSsoSweeper: mocks.startSsoSweeper }));

import { startProxyRuntime } from '../src/runtime.js';

describe('startProxyRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ROUTESHIFT_SKIP_MIGRATIONS;
    delete process.env.SEED_DEV_DATA;
    process.env.NODE_ENV = 'test';
    mocks.config.databaseUrl = 'postgres://example';
    mocks.config.clickhouseUrl = undefined;
  });

  it('runs migrations before starting the proxy when DATABASE_URL is configured', async () => {
    const proxy = { start: vi.fn() };

    await startProxyRuntime(proxy as never);

    expect(mocks.runMigrations).toHaveBeenCalledTimes(1);
    expect(mocks.assertPostgresRequestLogSchema).toHaveBeenCalledTimes(1);
    expect(mocks.runMigrations.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.assertPostgresRequestLogSchema.mock.invocationCallOrder[0]!);
    expect(proxy.start).toHaveBeenCalledTimes(1);
    expect(mocks.initLogger).toHaveBeenCalledTimes(1);
    expect(mocks.startPendingHoldReconciliationWorker).toHaveBeenCalledTimes(1);
    expect(mocks.initLogger.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.startPendingHoldReconciliationWorker.mock.invocationCallOrder[0]!);
    expect(mocks.startOrphanKeySweeper).toHaveBeenCalledTimes(1);
    expect(mocks.startSsoSweeper).toHaveBeenCalledTimes(1);
  });

  it('checks the live schema when startup migrations are explicitly skipped', async () => {
    process.env.ROUTESHIFT_SKIP_MIGRATIONS = '1';
    const proxy = { start: vi.fn() };

    await startProxyRuntime(proxy as never);

    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.assertPostgresRequestLogSchema).toHaveBeenCalledTimes(1);
    expect(proxy.start).toHaveBeenCalledTimes(1);
    expect(mocks.startSavingsReporter).toHaveBeenCalledTimes(1);
  });

  it('does not run migrations when DATABASE_URL is absent', async () => {
    mocks.config.databaseUrl = '';
    const proxy = { start: vi.fn() };

    await startProxyRuntime(proxy as never);

    expect(mocks.runMigrations).not.toHaveBeenCalled();
    expect(mocks.applyDevSeed).not.toHaveBeenCalled();
    expect(mocks.assertPostgresRequestLogSchema).not.toHaveBeenCalled();
    expect(mocks.startPendingHoldReconciliationWorker).not.toHaveBeenCalled();
    expect(proxy.start).toHaveBeenCalledTimes(1);
  });

  it('fails closed before logger initialization when the Postgres schema is stale', async () => {
    mocks.assertPostgresRequestLogSchema.mockRejectedValueOnce(
      new Error('Postgres request_logs schema is missing actual_cost_known'),
    );
    const proxy = { start: vi.fn() };

    await expect(startProxyRuntime(proxy as never)).rejects.toThrow('missing actual_cost_known');
    expect(mocks.initLogger).not.toHaveBeenCalled();
    expect(proxy.start).not.toHaveBeenCalled();
  });

  it('applies ClickHouse request-log columns before enabling a configured logger', async () => {
    mocks.config.clickhouseUrl = 'https://clickhouse.example';
    const proxy = { start: vi.fn() };

    await startProxyRuntime(proxy as never);

    expect(mocks.ensureClickHouseRequestLogColumns).toHaveBeenCalledWith('https://clickhouse.example');
    expect(mocks.ensureClickHouseRequestLogColumns.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.initLogger.mock.invocationCallOrder[0]!);
  });

  it('fails closed rather than starting a logger against a stale ClickHouse schema', async () => {
    mocks.config.clickhouseUrl = 'https://clickhouse.example';
    mocks.ensureClickHouseRequestLogColumns.mockRejectedValueOnce(new Error('schema rejected'));
    const proxy = { start: vi.fn() };

    await expect(startProxyRuntime(proxy as never)).rejects.toThrow('schema rejected');
    expect(mocks.initLogger).not.toHaveBeenCalled();
    expect(proxy.start).not.toHaveBeenCalled();
  });

  it('applies the dev seed outside production', async () => {
    process.env.NODE_ENV = 'test';
    const proxy = { start: vi.fn() };

    await startProxyRuntime(proxy as never);

    expect(mocks.applyDevSeed).toHaveBeenCalledTimes(1);
  });

  it('NEVER seeds the bootstrap admin in production', async () => {
    process.env.NODE_ENV = 'production';
    const proxy = { start: vi.fn() };

    await startProxyRuntime(proxy as never);

    expect(mocks.applyDevSeed).not.toHaveBeenCalled();
    expect(mocks.runMigrations).toHaveBeenCalledTimes(1); // schema still migrates
    expect(proxy.start).toHaveBeenCalledTimes(1);
  });

  it('allows an explicit SEED_DEV_DATA escape hatch even in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SEED_DEV_DATA = '1';
    const proxy = { start: vi.fn() };

    await startProxyRuntime(proxy as never);

    expect(mocks.applyDevSeed).toHaveBeenCalledTimes(1);
  });
});
