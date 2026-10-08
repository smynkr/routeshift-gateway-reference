import pg from 'pg';

const { Pool, types } = pg;

// Return PostgreSQL bigint (OID 20) as JavaScript number rather than the
// default string. Our bigints are usage counts and microcents costs that
// comfortably fit in Number.MAX_SAFE_INTEGER (microcents up to ~9e15 USD
// is well below 2^53). Without this, JSON aggregation responses would
// stringify counts and break typed consumers.
types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not configured');
    }
    pool = new Pool({
      connectionString,
      max: 10,
      // Bound both new TCP handshakes and waits for an available pooled
      // client. Money-path callers must fail closed instead of queuing forever
      // behind a saturated or blackholed database pool.
      connectionTimeoutMillis: 5_000,
      // Reap idle connections so we don't pin 10 sockets forever on a
      // 1-CPU container, and turn on TCP keep-alive so a firewall or
      // NAT mapping that silently drops idle sockets gets noticed
      // before the next request hits a half-dead connection.
      idleTimeoutMillis: 30_000,
      keepAlive: true,
    });
    pool.on('error', (err) => {
      console.error('Unexpected idle client error in connection pool:', err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
