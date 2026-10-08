import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { assertPostgresRequestLogSchema } from '../src/db/postgres-schema-guard.js';

const currentSchema = {
  actual_cost_known_valid: true,
  layer_identity_id_valid: true,
  reasoning_tokens_valid: true,
  reasoning_cost_microcents_valid: true,
  session_metrics_unknown_cost_requests_valid: true,
  pending_holds_columns_valid: true,
  pending_holds_primary_key_valid: true,
  pending_holds_checks_valid: true,
  pending_holds_tenant_fk_valid: true,
  pending_holds_active_index_valid: true,
};

describe('assertPostgresRequestLogSchema', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('accepts a current request_logs schema', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [currentSchema],
    });

    await expect(assertPostgresRequestLogSchema()).resolves.toBeUndefined();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("to_regclass('request_logs')"));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("to_regclass('session_metrics')"));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("'unknown_cost_requests'"));
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("to_regclass('pending_unknown_cost_holds')"),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('pending_unknown_cost_holds_terminal_resolution'),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('idx_pending_unknown_cost_holds_active'),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_get_constraintdef'),
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('uncollected_known_charge_microcents = 0'),
    );
  });

  it('rejects a stale request_logs schema missing actual_cost_known', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ ...currentSchema, actual_cost_known_valid: false }],
    });

    await expect(assertPostgresRequestLogSchema())
      .rejects.toThrow('Postgres request_logs schema is missing actual_cost_known; apply migration 053 before startup');
  });

  it('rejects a stale request_logs schema missing layer_identity_id (AXI-8)', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ ...currentSchema, layer_identity_id_valid: false }],
    });

    await expect(assertPostgresRequestLogSchema())
      .rejects.toThrow('Postgres request_logs schema is missing layer_identity_id; apply migration 058 before startup');
  });

  it.each([
    ['reasoning_tokens', 'reasoning_tokens_valid'],
    ['reasoning_cost_microcents', 'reasoning_cost_microcents_valid'],
  ] as const)('rejects a stale request_logs schema missing %s', async (column, field) => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ ...currentSchema, [field]: false }],
    });

    await expect(assertPostgresRequestLogSchema())
      .rejects.toThrow(`Postgres request_logs schema is missing ${column}; apply migration 059 before startup`);
  });

  it('rejects session_metrics without the qualified unknown-cost counter shape', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ ...currentSchema, session_metrics_unknown_cost_requests_valid: false }],
    });

    await expect(assertPostgresRequestLogSchema())
      .rejects.toThrow('Postgres session_metrics schema is missing unknown_cost_requests; apply migration 055 before startup');
  });

  it.each([
    [
      'required column shape',
      'pending_holds_columns_valid',
      'columns do not match migration 054',
    ],
    [
      'tenant-scoped primary key',
      'pending_holds_primary_key_valid',
      'tenant-scoped primary key',
    ],
    [
      'validated monetary checks',
      'pending_holds_checks_valid',
      'validated monetary or lifecycle constraints',
    ],
    [
      'cascading tenant foreign key',
      'pending_holds_tenant_fk_valid',
      'cascading team foreign key',
    ],
    [
      'validated active-state index',
      'pending_holds_active_index_valid',
      'validated active-state index',
    ],
  ] as const)('rejects a hold table missing its %s', async (_label, field, message) => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ ...currentSchema, [field]: false }],
    });

    await expect(assertPostgresRequestLogSchema()).rejects.toThrow(message);
  });
});

import { assertPostgresBudgetLedgerSchema } from '../src/db/postgres-schema-guard.js';

const currentBudgetLedgerSchema = {
  team_budget_caps_columns_valid: true,
  api_key_budget_caps_columns_valid: true,
  identity_budget_caps_columns_valid: true,
  identity_budget_caps_pkey_valid: true,
  identity_budget_caps_quantization_daily_valid: true,
  identity_budget_caps_quantization_weekly_valid: true,
  identity_budget_caps_quantization_monthly_valid: true,
  identity_budget_caps_action_valid: true,
  identity_budget_caps_nonempty_valid: true,
  identity_budget_caps_alert_pct_valid: true,
  identity_budget_caps_team_fk_valid: true,
  budget_period_columns_valid: true,
  budget_reservations_columns_valid: true,
  budget_seeded_columns_valid: true,
  budget_period_windows_valid: true,
  budget_period_no_forbidden_check: true,
  budget_reservations_held_bound_valid: true,
  budget_reservations_status_valid: true,
  budget_period_team_unique_valid: true,
  budget_period_key_unique_valid: true,
  budget_period_immutable_trigger_valid: true,
  budget_period_key_trigger_valid: true,
  budget_reservation_scope_trigger_valid: true,
  budget_period_identity_unique_valid: true,
  budget_period_single_scope_trigger_valid: true,
};

describe('assertPostgresBudgetLedgerSchema', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('accepts a current budget ledger schema', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [currentBudgetLedgerSchema],
    });

    await expect(assertPostgresBudgetLedgerSchema()).resolves.toBeUndefined();
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("to_regclass('budget_period_usage')"));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("to_regclass('budget_reservations')"));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("to_regclass('budget_period_seeded_requests')"));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('idx_budget_period_usage_team_unique'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('idx_budget_period_usage_identity_unique'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('budget_period_single_scope_trigger'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('identity_budget_caps'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('budget_period_identity_immutable_trigger'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('pg_get_functiondef'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('api_key_id is null'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('identity_id is null'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('identity_id is not null'));
  });

  it.each([
    ['team_budget_caps_columns_valid', 'budget cap columns are missing; apply migration 061'],
    ['api_key_budget_caps_columns_valid', 'budget cap columns are missing; apply migration 061'],
    ['identity_budget_caps_columns_valid', 'identity_budget_caps columns do not match migration 065'],
    ['identity_budget_caps_pkey_valid', 'missing its (team_id, identity_id) primary key; apply migration 065'],
    ['identity_budget_caps_quantization_daily_valid', 'missing its per-window quantization, cap_action, nonempty, alert-pct checks or team FK; apply migration 065'],
    ['identity_budget_caps_quantization_weekly_valid', 'missing its per-window quantization, cap_action, nonempty, alert-pct checks or team FK; apply migration 065'],
    ['identity_budget_caps_quantization_monthly_valid', 'missing its per-window quantization, cap_action, nonempty, alert-pct checks or team FK; apply migration 065'],
    ['identity_budget_caps_action_valid', 'missing its per-window quantization, cap_action, nonempty, alert-pct checks or team FK; apply migration 065'],
    ['identity_budget_caps_nonempty_valid', 'missing its per-window quantization, cap_action, nonempty, alert-pct checks or team FK; apply migration 065'],
    ['identity_budget_caps_alert_pct_valid', 'missing its per-window quantization, cap_action, nonempty, alert-pct checks or team FK; apply migration 065'],
    ['identity_budget_caps_team_fk_valid', 'missing its per-window quantization, cap_action, nonempty, alert-pct checks or team FK; apply migration 065'],
    ['budget_period_columns_valid', 'budget_period_usage columns do not match migrations 061/065'],
    ['budget_reservations_columns_valid', 'budget_reservations columns do not match migrations 061/065'],
    ['budget_seeded_columns_valid', 'budget_period_seeded_requests columns do not match migration 061'],
    ['budget_period_windows_valid', 'missing its three-window check'],
    ['budget_period_no_forbidden_check', 'forbidden held<=reserved relational check'],
    ['budget_reservations_held_bound_valid', 'missing its per-row unknown-held bound'],
    ['budget_reservations_status_valid', 'missing its lifecycle status check'],
    ['budget_period_team_unique_valid', 'missing its exact partial unique indexes'],
    ['budget_period_key_unique_valid', 'missing its exact partial unique indexes'],
    ['budget_period_identity_unique_valid', 'missing its identity unique index; apply migration 065'],
    ['budget_period_single_scope_trigger_valid', 'missing its single-scope guard trigger; apply migration 065'],
    ['budget_period_immutable_trigger_valid', 'missing its identity/scope triggers'],
    ['budget_period_key_trigger_valid', 'missing its identity/scope triggers'],
    ['budget_reservation_scope_trigger_valid', 'missing its identity/scope triggers'],
  ] as const)('rejects a stale budget ledger schema with %s false', async (field, message) => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ ...currentBudgetLedgerSchema, [field]: false }],
    });

    await expect(assertPostgresBudgetLedgerSchema()).rejects.toThrow(message);
  });
});
