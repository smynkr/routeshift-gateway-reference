import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../src/db/migrations/054-pending-unknown-cost-holds.sql', import.meta.url),
  'utf8',
);

describe('054 pending unknown-cost holds migration', () => {
  it('uses a tenant-scoped TEXT key and durable non-negative monetary constraints', () => {
    expect(migration).toContain('team_id TEXT NOT NULL');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_team_fk FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_pkey PRIMARY KEY (team_id, request_id)');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_reserved_nonnegative CHECK (reserved_microcents >= 0)');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_known_charge_nonnegative CHECK (known_charge_microcents >= 0)');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_uncollected_known_charge_nonnegative CHECK (uncollected_known_charge_microcents >= 0)');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_held_bounds CHECK');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_estimate_nonnegative CHECK');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_markup_nonnegative CHECK (markup_percent >= 0)');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_reason_nonempty CHECK');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_unknown_attempts_nonnegative CHECK (unknown_attempts >= 0)');
    expect(migration).toContain("status IN ('reserved', 'pending', 'reconciliation_required', 'reconciled', 'released')");
    expect(migration).toContain('resolved_at TIMESTAMPTZ');
    expect(migration).toContain('resolution_raw_cost_microcents BIGINT');
    expect(migration).toContain('resolution_charge_microcents BIGINT');
    expect(migration).toContain('resolution_evidence TEXT');
    expect(migration).toContain('resolution_note TEXT');
    expect(migration).toContain('resolved_by TEXT');
    expect(migration).toContain('CONSTRAINT pending_unknown_cost_holds_terminal_resolution CHECK');
    expect(migration).toContain('uncollected_known_charge_microcents = 0');
  });
});
