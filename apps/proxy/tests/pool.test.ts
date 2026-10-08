import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  end: vi.fn(async () => {}),
  Pool: vi.fn(),
}));

vi.mock('pg', () => {
  return {
    default: {
      Pool: mocks.Pool,
      // pool.ts destructures `types` to register a bigint (OID 20) parser.
      types: { setTypeParser: vi.fn() },
    },
  };
});

describe('db pool', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.Pool.mockImplementation(() => ({ on: mocks.on, end: mocks.end }));
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    const mod = await import('../src/db/pool.js');
    await mod.closePool();
  });

  it('fails closed when DATABASE_URL is not configured', async () => {
    const { getPool } = await import('../src/db/pool.js');

    expect(() => getPool()).toThrow('DATABASE_URL is not configured');
    expect(mocks.Pool).not.toHaveBeenCalled();
  });

  it('creates a singleton pool from DATABASE_URL and resets on closePool', async () => {
    process.env.DATABASE_URL = 'postgres://example/db';
    const { getPool, closePool } = await import('../src/db/pool.js');

    const first = getPool();
    const second = getPool();

    expect(first).toBe(second);
    expect(mocks.Pool).toHaveBeenCalledTimes(1);
    expect(mocks.Pool).toHaveBeenCalledWith({
      connectionString: 'postgres://example/db',
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
    });
    expect(mocks.on).toHaveBeenCalledWith('error', expect.any(Function));

    await closePool();
    expect(mocks.end).toHaveBeenCalledTimes(1);

    getPool();
    expect(mocks.Pool).toHaveBeenCalledTimes(2);
  });
});
