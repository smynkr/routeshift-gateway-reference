import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../src/db/migrations/055-session-metrics-unknown-cost-qualification.sql', import.meta.url),
  'utf8',
);

describe('055 session-metrics unknown-cost qualification migration', () => {
  it('backfills only the derived session projection at its tenant/session grain', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS unknown_cost_requests INTEGER NOT NULL DEFAULT 0');
    expect(migration).toContain('UPDATE session_metrics AS metrics');
    expect(migration).toContain('COUNT(*) FILTER (WHERE actual_cost_known = false)::integer');
    expect(migration).toContain('GROUP BY team_id, session_id');
    expect(migration).toContain('metrics.team_id = source.team_id');
    expect(migration).toContain('metrics.session_id = source.session_id');
  });
});
