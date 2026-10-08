import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  poolQuery: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  log: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readdirSync: mocks.readdirSync,
  readFileSync: mocks.readFileSync,
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: mocks.connect,
  }),
}));

import { runMigrations, orderMigrationFiles } from '../src/db/migrate.js';

describe('orderMigrationFiles', () => {
  it('orders by numeric prefix, not lexically (the unpadded-filename footgun)', () => {
    // Lexical sort would give ['039-d','100-c','40-b','9-a'] — wrong.
    expect(orderMigrationFiles(['100-c.sql', '9-a.sql', '40-b.sql', '039-d.sql'])).toEqual([
      '9-a.sql', '039-d.sql', '40-b.sql', '100-c.sql',
    ]);
  });

  it('is a no-op for the current zero-padded set (order matches lexical)', () => {
    const padded = ['001-a.sql', '002-b.sql', '010-c.sql', '039-d.sql'];
    expect(orderMigrationFiles(padded)).toEqual(padded);
    // ...and equals what the old lexical sort produced for padded names.
    expect(orderMigrationFiles(padded)).toEqual([...padded].sort());
  });

  it('falls back to lexical for equal or non-numeric prefixes (deterministic)', () => {
    expect(orderMigrationFiles(['005-b.sql', '005-a.sql'])).toEqual(['005-a.sql', '005-b.sql']);
    expect(orderMigrationFiles(['zebra.sql', 'alpha.sql'])).toEqual(['alpha.sql', 'zebra.sql']);
  });
});

describe('runMigrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(mocks.log);

    mocks.readdirSync.mockReturnValue(['001_init.sql']);
    mocks.readFileSync.mockReturnValue('CREATE TABLE example(id text primary key);');

    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.release.mockImplementation(() => {});
    mocks.connect.mockResolvedValue({
      query: mocks.clientQuery,
      release: mocks.release,
    });
  });

  it('applies pending migrations inside a transaction', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT migration exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // migration SQL
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // insert _migrations
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    await runMigrations();

    expect(mocks.poolQuery).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS _migrations'));
    expect(mocks.readdirSync).toHaveBeenCalledTimes(1);
    expect(mocks.readFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(2, 'SELECT 1 FROM _migrations WHERE name = $1', ['001_init.sql']);
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(4, 'INSERT INTO _migrations (name) VALUES ($1)', ['001_init.sql']);
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(5, 'COMMIT');
    expect(mocks.log).toHaveBeenCalledWith('Applied migration: 001_init.sql');
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('applies the deployed 053 request-log schema before the 054 unknown-cost hold table', async () => {
    mocks.readdirSync.mockReturnValue([
      '054-pending-unknown-cost-holds.sql',
      '053-request-logs-actual-cost-known.sql',
    ]);
    mocks.readFileSync.mockImplementation((file: string | URL) => (
      String(file).includes('053-request-logs-actual-cost-known.sql')
        ? 'ALTER TABLE request_logs ADD COLUMN actual_cost_known boolean;'
        : 'CREATE TABLE pending_unknown_cost_holds (team_id text);'
    ));

    await runMigrations();

    expect(mocks.readFileSync.mock.calls.map(([file]) => String(file))).toEqual([
      expect.stringContaining('053-request-logs-actual-cost-known.sql'),
      expect.stringContaining('054-pending-unknown-cost-holds.sql'),
    ]);
    const migrationSql = mocks.clientQuery.mock.calls
      .map(([query]) => String(query))
      .filter((query) => query.startsWith('ALTER TABLE') || query.startsWith('CREATE TABLE pending'));
    expect(migrationSql).toEqual([
      'ALTER TABLE request_logs ADD COLUMN actual_cost_known boolean;',
      'CREATE TABLE pending_unknown_cost_holds (team_id text);',
    ]);
    expect(mocks.log).toHaveBeenNthCalledWith(1, 'Applied migration: 053-request-logs-actual-cost-known.sql');
    expect(mocks.log).toHaveBeenNthCalledWith(2, 'Applied migration: 054-pending-unknown-cost-holds.sql');
  });

  it('applies the 055 session qualification projection after request-cost knownness', async () => {
    mocks.readdirSync.mockReturnValue([
      '055-session-metrics-unknown-cost-qualification.sql',
      '053-request-logs-actual-cost-known.sql',
    ]);
    mocks.readFileSync.mockImplementation((file: string | URL) => (
      String(file).includes('053-request-logs-actual-cost-known.sql')
        ? 'ALTER TABLE request_logs ADD COLUMN actual_cost_known boolean;'
        : 'ALTER TABLE session_metrics ADD COLUMN unknown_cost_requests integer;'
    ));

    await runMigrations();

    expect(mocks.readFileSync.mock.calls.map(([file]) => String(file))).toEqual([
      expect.stringContaining('053-request-logs-actual-cost-known.sql'),
      expect.stringContaining('055-session-metrics-unknown-cost-qualification.sql'),
    ]);
    expect(mocks.log).toHaveBeenNthCalledWith(2, 'Applied migration: 055-session-metrics-unknown-cost-qualification.sql');
  });

  it('skips migrations that are already recorded', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ one: 1 }], rowCount: 1 }) // SELECT migration exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ROLLBACK

    await runMigrations();

    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.clientQuery).toHaveBeenNthCalledWith(3, 'ROLLBACK');
    expect(mocks.log).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
