import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// RSH-59: the bootstrap admin (admin@routeshift.io with a committed bcrypt hash)
// and the routeshift.io self-provision allowlist must NOT be seeded by the
// always-applied migrations (they run in production). They move to a dev-only
// seed gated by runtime.ts.

const poolQuery = vi.hoisted(() => vi.fn(async () => ({ rows: [], rowCount: 0 })));
vi.mock('../src/db/pool.js', () => ({ getPool: () => ({ query: poolQuery }) }));

import { applyDevSeed } from '../src/db/migrate.js';

const migrationsDir = join(__dirname, '../src/db/migrations');
const readMigration = (f: string) => readFileSync(join(migrationsDir, f), 'utf8');

describe('production migrations no longer seed a login credential (RSH-59)', () => {
  it('002-users.sql keeps its DDL but seeds no admin user', () => {
    const sql = readMigration('002-users.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(sql).not.toContain('admin@routeshift.io');
    expect(sql).not.toContain('INSERT INTO users');
    expect(sql).not.toContain('INSERT INTO team_members');
  });

  it('030-oauth-device-flow.sql keeps its DDL but seeds no routeshift.io allowlist', () => {
    const sql = readMigration('030-oauth-device-flow.sql');
    expect(sql).toContain('key_identities');
    expect(sql).not.toContain('routeshift.io');
    expect(sql).not.toContain('aed_dev');
  });
});

describe('applyDevSeed (dev-only bootstrap)', () => {
  it('seeds the bootstrap admin + dev allowlist idempotently', async () => {
    poolQuery.mockClear();
    await applyDevSeed();
    const sql = poolQuery.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toContain('admin@routeshift.io');
    expect(sql).toContain("'routeshift.io'");
    expect(sql).toContain('ON CONFLICT'); // safe to run on every dev startup
  });
});
