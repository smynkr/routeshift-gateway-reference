import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../src/db/migrations/065-identity-budget-caps.sql', import.meta.url),
  'utf8',
);

describe('065 identity budget caps migration (RSH-140)', () => {
  it('adds identity_budget_caps with the team-cap shape and exact-decimal CHECKs', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS identity_budget_caps');
    expect(migration).toContain('team_id TEXT NOT NULL REFERENCES teams(id)');
    expect(migration).not.toContain('uuid');
    expect(migration).toContain('daily_usd_cap numeric(20,8)');
    expect(migration).toContain('weekly_usd_cap numeric(20,8)');
    expect(migration).toContain('monthly_usd_cap numeric(20,8)');
    expect(migration).toContain('trunc(daily_usd_cap, 8)');
    expect(migration).toContain("cap_action IN ('alert', 'throttle', 'block')");
    expect(migration).toContain('PRIMARY KEY (team_id, identity_id)');
  });

  it('adds identity_id to the ledger tables and narrows the 061 team unique index', () => {
    expect(migration).toContain('ALTER TABLE budget_period_usage\n  ADD COLUMN IF NOT EXISTS identity_id TEXT');
    expect(migration).toContain('ALTER TABLE budget_reservations\n  ADD COLUMN IF NOT EXISTS identity_id TEXT');
    // the CRITICAL narrowing: identity rows are api_key_id NULL, so without
    // the identity predicate they collide with the team row's unique index
    expect(migration).toContain('DROP INDEX IF EXISTS idx_budget_period_usage_team_unique');
    expect(migration).toContain('WHERE api_key_id IS NULL AND identity_id IS NULL');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_period_usage_identity_unique');
    expect(migration).toContain('WHERE api_key_id IS NULL AND identity_id IS NOT NULL');
  });

  it('enforces the single-scope guard and identity immutability', () => {
    expect(migration).toContain('budget_period_single_scope');
    expect(migration).toContain("NEW.api_key_id IS NOT NULL AND NEW.identity_id IS NOT NULL");
    expect(migration).toContain('RAISE EXCEPTION');
    expect(migration).toContain('OR OLD.identity_id IS DISTINCT FROM NEW.identity_id');
    // reservation scope-match covers identity too
    expect(migration).toContain('budget_reservation_scope_matches_period');
    expect(migration).toContain('OR NEW.identity_id IS DISTINCT FROM period_identity');
  });

  it('is additive and idempotent', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS');
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION');
    expect(migration).toContain('DROP TRIGGER IF EXISTS');
  });
});

describe('startup schema guard regex literals (regression: JS escape stripping)', () => {
  // The guard's SQL regexes are single-quoted JS string literals. Unknown
  // escapes (\] or \() are stripped by the JS runtime (']' / '('), which
  // breaks the POSIX regex: '...array\[''alert'', ..., ''block''\]$' becomes
  // '...array[''alert'', ..., ''block'']$', where '[' opens a character class
  // and the '$' anchor can never match. 2026-08-12: the first deployment of
  // the 065-pinning guard crash-looped every proxy container against a
  // perfectly valid database with "identity_budget_caps is missing its
  // per-window quantization...". The literals must double the backslash
  // (\\[ / \\]) so the emitted runtime string keeps the regex escapes.
  const guard = readFileSync(
    new URL('../src/db/postgres-schema-guard.ts', import.meta.url),
    'utf8',
  );

  it('cap_action regex is double-escaped so the runtime value keeps its brackets', () => {
    const line = guard.split('\n').find((l) => l.includes('cap_action = any array'))!;
    // File text must carry TWO backslashes before each bracket:
    expect(line).toContain("array\\\\[''alert''");
    expect(line).toMatch(/block''\\\\\]\$/);
    // The single-escaped form (the bug) must NOT be present:
    expect(line).not.toMatch(/array\\\[/);
  });

  it('index-shape regexes double-escape their parens', () => {
    const lines = guard.split('\n').filter((l) => l.includes(") ~ '"));
    const parenLines = lines.filter((l) => l.includes('team_id, window_kind') || l.includes('team_id, identity_id, window_kind'));
    expect(parenLines.length).toBeGreaterThanOrEqual(2);
    for (const line of parenLines) {
      expect(line).toContain("'\\\\(");
      expect(line).toMatch(/\\\\\)'/);
    }
  });
});
