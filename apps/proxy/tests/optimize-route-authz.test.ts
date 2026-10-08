import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handleOptimizeFindings = vi.fn(async (_req: unknown, res: { writeHead: (code: number, h: Record<string, string>) => void; end: (body?: string) => void }) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ findings: [] }));
  });
  const poolQuery = vi.fn().mockResolvedValue({ rows: [] });
  const config = {
    corsOrigins: ['*'],
    databaseUrl: undefined as string | undefined,
  };

  return { handleOptimizeFindings, poolQuery, config };
});

vi.mock('../src/optimize/findings-endpoint.js', () => ({
  handleOptimizeFindings: mocks.handleOptimizeFindings,
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
}));

vi.mock('../src/config.js', () => ({
  config: mocks.config,
}));

import { createProxyServer } from '../src/server.js';

describe('admin optimize findings route authz', () => {
  const originalEnv = { ...process.env };
  let instance: ReturnType<typeof createProxyServer> | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    process.env.ADMIN_SECRET = 'super-secret-admin-token';
    process.env.NODE_ENV = 'production';
    mocks.handleOptimizeFindings.mockClear();
    mocks.poolQuery.mockClear();
    mocks.config.corsOrigins = ['*'];
    mocks.config.databaseUrl = undefined;

    instance = createProxyServer(0);
    await instance.start();
    const address = instance.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (instance) await instance.stop();
    instance = null;
    process.env = { ...originalEnv };
  });

  it('rejects a customer key before the optimize handler or DB is reached', async () => {
    const response = await fetch(
      `${baseUrl}/admin/optimize/findings?team_id=11111111-1111-1111-1111-111111111111`,
      { headers: { Authorization: 'Bearer sk-proxy-customer-key' } },
    );

    expect(response.status).toBe(401);
    expect(mocks.handleOptimizeFindings).not.toHaveBeenCalled();
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });
});
