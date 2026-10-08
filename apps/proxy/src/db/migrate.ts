import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// RSH-59: local-dev-only bootstrap. The admin@routeshift.io owner (and the
// routeshift.io self-provision allowlist) used to live in the always-applied
// migrations, so a committed bcrypt hash became a live LOGIN on the production
// dashboard. These now live here and are applied ONLY outside production (see
// runtime.ts gating). Idempotent — safe to run on every dev startup. Inlined
// rather than read from a file so there is nothing to copy into the build.
const DEV_SEED_SQL = `
INSERT INTO users (id, email, name, password_hash)
VALUES ('user_dev', 'admin@routeshift.io', 'Admin', '$2a$12$LJ3m4ys3Lg.woe/xyWSeaepEgVBMy2gHVhHCKcMWWxpts8LUo91W6')
ON CONFLICT (id) DO NOTHING;

INSERT INTO team_members (user_id, team_id, role)
VALUES ('user_dev', 'team_dev', 'owner')
ON CONFLICT (user_id, team_id) DO NOTHING;

INSERT INTO allowed_email_domains (id, team_id, domain)
VALUES ('aed_dev', 'team_dev', 'routeshift.io')
ON CONFLICT (team_id, domain) DO NOTHING;
`;

/**
 * Apply the dev-only bootstrap seed. MUST NOT run in production — callers gate
 * on NODE_ENV (runtime.ts). Runs after runMigrations() so the referenced tables
 * (users, team_members, allowed_email_domains, team_dev) already exist.
 */
export async function applyDevSeed(): Promise<void> {
  const pool = getPool();
  await pool.query(DEV_SEED_SQL);
  console.log('Applied dev seed (non-production bootstrap)');
}

/**
 * Order migration files by their numeric prefix, not lexically. Files are named
 * `NNN-description.sql`; a plain `.sort()` only matched numeric order by accident
 * of the 3-digit zero-padding. An unpadded `40-x.sql` would lexically sort after
 * `039-x.sql` but a `9-x.sql` would sort before `10-x.sql` — applying migrations
 * out of order, which can corrupt schema state. Sort by the parsed leading
 * integer; fall back to lexical for equal or non-numeric prefixes so the order
 * stays deterministic. For the current zero-padded set this is a no-op.
 */
export function orderMigrationFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export async function runMigrations(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = join(__dirname, 'migrations');
  const files = orderMigrationFiles(readdirSync(migrationsDir).filter(f => f.endsWith('.sql')));

  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
      if (rows.length > 0) {
        await client.query('ROLLBACK');
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`Applied migration: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
