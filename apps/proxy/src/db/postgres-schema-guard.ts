import { getPool } from './pool.js';

// Migrations 053 and 054 establish the knownness flag plus the durable
// request-reservation lifecycle. Startup verifies their live shape so
// ROUTESHIFT_SKIP_MIGRATIONS (or a drifted CREATE TABLE IF NOT EXISTS target)
// cannot enable money movement against a merely same-named relation.
const UNKNOWN_COST_SCHEMA_QUERY = `
  WITH hold_relation AS (
    SELECT to_regclass('pending_unknown_cost_holds') AS oid
  ),
  expected_hold_columns(attname, typname, attnotnull) AS (
    VALUES
      ('team_id', 'text', true),
      ('request_id', 'text', true),
      ('reserved_microcents', 'int8', true),
      ('known_charge_microcents', 'int8', true),
      ('uncollected_known_charge_microcents', 'int8', true),
      ('held_microcents', 'int8', true),
      ('unknown_cost_estimate_microcents', 'int8', false),
      ('markup_percent', 'numeric', true),
      ('reason_code', 'text', true),
      ('unknown_attempts', 'int4', true),
      ('status', 'text', true),
      ('created_at', 'timestamptz', true),
      ('updated_at', 'timestamptz', true),
      ('resolved_at', 'timestamptz', false),
      ('resolution_raw_cost_microcents', 'int8', false),
      ('resolution_charge_microcents', 'int8', false),
      ('resolution_evidence', 'text', false),
      ('resolution_note', 'text', false),
      ('resolved_by', 'text', false)
  ),
  expected_hold_check_fragments(conname, definition_fragment) AS (
    VALUES
      ('pending_unknown_cost_holds_reserved_nonnegative', 'reserved_microcents >= 0'),
      ('pending_unknown_cost_holds_known_charge_nonnegative', 'known_charge_microcents >= 0'),
      ('pending_unknown_cost_holds_uncollected_known_charge_nonnegative', 'uncollected_known_charge_microcents >= 0'),
      ('pending_unknown_cost_holds_held_bounds', 'held_microcents >= 0'),
      ('pending_unknown_cost_holds_held_bounds', 'held_microcents <= reserved_microcents'),
      ('pending_unknown_cost_holds_estimate_nonnegative', 'unknown_cost_estimate_microcents is null'),
      ('pending_unknown_cost_holds_estimate_nonnegative', 'unknown_cost_estimate_microcents >= 0'),
      ('pending_unknown_cost_holds_markup_nonnegative', 'markup_percent >= 0'),
      ('pending_unknown_cost_holds_reason_nonempty', 'length'),
      ('pending_unknown_cost_holds_reason_nonempty', 'reason_code'),
      ('pending_unknown_cost_holds_unknown_attempts_nonnegative', 'unknown_attempts >= 0'),
      ('pending_unknown_cost_holds_status_valid', 'reserved'),
      ('pending_unknown_cost_holds_status_valid', 'pending'),
      ('pending_unknown_cost_holds_status_valid', 'reconciliation_required'),
      ('pending_unknown_cost_holds_status_valid', 'reconciled'),
      ('pending_unknown_cost_holds_status_valid', 'released'),
      ('pending_unknown_cost_holds_resolution_values_nonnegative', 'resolution_raw_cost_microcents is null'),
      ('pending_unknown_cost_holds_resolution_values_nonnegative', 'resolution_raw_cost_microcents >= 0'),
      ('pending_unknown_cost_holds_resolution_charge_nonnegative', 'resolution_charge_microcents is null'),
      ('pending_unknown_cost_holds_resolution_charge_nonnegative', 'resolution_charge_microcents >= 0'),
      ('pending_unknown_cost_holds_terminal_resolution', 'resolved_at is not null'),
      ('pending_unknown_cost_holds_terminal_resolution', 'resolution_raw_cost_microcents is not null'),
      ('pending_unknown_cost_holds_terminal_resolution', 'resolution_charge_microcents is not null'),
      ('pending_unknown_cost_holds_terminal_resolution', 'uncollected_known_charge_microcents = 0'),
      ('pending_unknown_cost_holds_terminal_resolution', 'resolution_evidence'),
      ('pending_unknown_cost_holds_terminal_resolution', 'resolution_note'),
      ('pending_unknown_cost_holds_terminal_resolution', 'resolved_by')
  )
  SELECT
    EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('request_logs')
        AND attribute.attname = 'actual_cost_known'
        AND attribute.atttypid = 'boolean'::regtype
        AND attribute.attnotnull
        AND NOT attribute.attisdropped
    ) AS actual_cost_known_valid,
    EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('request_logs')
        AND attribute.attname = 'layer_identity_id'
        AND attribute.atttypid = 'text'::regtype
        AND NOT attribute.attisdropped
    ) AS layer_identity_id_valid,
    EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('request_logs')
        AND attribute.attname = 'reasoning_tokens'
        AND attribute.atttypid = 'int4'::regtype
        AND NOT attribute.attnotnull
        AND NOT attribute.attisdropped
    ) AS reasoning_tokens_valid,
    EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('request_logs')
        AND attribute.attname = 'reasoning_cost_microcents'
        AND attribute.atttypid = 'int8'::regtype
        AND NOT attribute.attnotnull
        AND NOT attribute.attisdropped
    ) AS reasoning_cost_microcents_valid,
    EXISTS (
      SELECT 1
      FROM pg_attribute attribute
      JOIN pg_attrdef default_row
        ON default_row.adrelid = attribute.attrelid
       AND default_row.adnum = attribute.attnum
      WHERE attribute.attrelid = to_regclass('session_metrics')
        AND attribute.attname = 'unknown_cost_requests'
        AND attribute.atttypid = 'int4'::regtype
        AND attribute.attnotnull
        AND attribute.atthasdef
        AND NOT attribute.attisdropped
        AND regexp_replace(
          lower(pg_get_expr(default_row.adbin, default_row.adrelid)),
          '::[a-z0-9_]+', '', 'g'
        ) = '0'
    ) AS session_metrics_unknown_cost_requests_valid,
    (
      SELECT count(*) = (SELECT count(*) FROM expected_hold_columns)
      FROM expected_hold_columns expected
      JOIN hold_relation relation ON relation.oid IS NOT NULL
      JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attname = expected.attname
       AND attribute.attnotnull = expected.attnotnull
       AND NOT attribute.attisdropped
      JOIN pg_type type_row
        ON type_row.oid = attribute.atttypid
       AND type_row.typname = expected.typname
    ) AS pending_holds_columns_valid,
    EXISTS (
      SELECT 1
      FROM hold_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.conname = 'pending_unknown_cost_holds_pkey'
       AND constraint_row.contype = 'p'
       AND constraint_row.convalidated
      WHERE constraint_row.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = relation.oid AND attname = 'team_id'),
        (SELECT attnum FROM pg_attribute WHERE attrelid = relation.oid AND attname = 'request_id')
      ]::smallint[]
    ) AS pending_holds_primary_key_valid,
    NOT EXISTS (
      SELECT 1
      FROM expected_hold_check_fragments expected
      WHERE NOT EXISTS (
        SELECT 1
        FROM hold_relation relation
        JOIN pg_constraint constraint_row
          ON constraint_row.conrelid = relation.oid
         AND constraint_row.conname = expected.conname
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND position(
           expected.definition_fragment
           IN regexp_replace(
             lower(pg_get_constraintdef(constraint_row.oid)),
             '[()"]|::[a-z0-9_]+',
             '',
             'g'
           )
         ) > 0
      )
    ) AS pending_holds_checks_valid,
    EXISTS (
      SELECT 1
      FROM hold_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.conname = 'pending_unknown_cost_holds_team_fk'
       AND constraint_row.contype = 'f'
       AND constraint_row.confrelid = to_regclass('teams')
       AND constraint_row.confdeltype = 'c'
       AND constraint_row.convalidated
      WHERE constraint_row.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute WHERE attrelid = relation.oid AND attname = 'team_id')
      ]::smallint[]
        AND constraint_row.confkey = ARRAY[
          (SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'id')
        ]::smallint[]
    ) AS pending_holds_tenant_fk_valid,
    EXISTS (
      SELECT 1
      FROM hold_relation relation
      JOIN pg_index index_row
        ON index_row.indrelid = relation.oid
       AND index_row.indisvalid
       AND index_row.indisready
      JOIN pg_class index_relation
        ON index_relation.oid = index_row.indexrelid
       AND index_relation.relname = 'idx_pending_unknown_cost_holds_active'
      WHERE lower(pg_get_indexdef(index_row.indexrelid))
              LIKE '%(status, updated_at)%'
        AND lower(pg_get_expr(index_row.indpred, index_row.indrelid))
              LIKE '%reconciliation_required%'
        AND lower(pg_get_expr(index_row.indpred, index_row.indrelid))
              LIKE '%reserved%'
        AND lower(pg_get_expr(index_row.indpred, index_row.indrelid))
              LIKE '%pending%'
    ) AS pending_holds_active_index_valid
`;

/**
 * Assert that the Postgres request_logs relation can persist unknown-cost
 * evidence emitted by the logger. This is intentionally read-only: migrations
 * own all schema changes.
 */
export async function assertPostgresRequestLogSchema(): Promise<void> {
  const { rows } = await getPool().query<{
    actual_cost_known_valid: boolean;
    layer_identity_id_valid: boolean;
    reasoning_tokens_valid: boolean;
    reasoning_cost_microcents_valid: boolean;
    session_metrics_unknown_cost_requests_valid: boolean;
    pending_holds_columns_valid: boolean;
    pending_holds_primary_key_valid: boolean;
    pending_holds_checks_valid: boolean;
    pending_holds_tenant_fk_valid: boolean;
    pending_holds_active_index_valid: boolean;
  }>(
    UNKNOWN_COST_SCHEMA_QUERY,
  );

  if (rows[0]?.actual_cost_known_valid !== true) {
    throw new Error(
      'Postgres request_logs schema is missing actual_cost_known; apply migration 053 before startup',
    );
  }
  if (rows[0]?.layer_identity_id_valid !== true) {
    throw new Error(
      'Postgres request_logs schema is missing layer_identity_id; apply migration 058 before startup',
    );
  }
  if (rows[0]?.reasoning_tokens_valid !== true) {
    throw new Error(
      'Postgres request_logs schema is missing reasoning_tokens; apply migration 059 before startup',
    );
  }
  if (rows[0]?.reasoning_cost_microcents_valid !== true) {
    throw new Error(
      'Postgres request_logs schema is missing reasoning_cost_microcents; apply migration 059 before startup',
    );
  }
  if (rows[0]?.session_metrics_unknown_cost_requests_valid !== true) {
    throw new Error(
      'Postgres session_metrics schema is missing unknown_cost_requests; apply migration 055 before startup',
    );
  }
  if (rows[0]?.pending_holds_columns_valid !== true) {
    throw new Error(
      'Postgres pending_unknown_cost_holds columns do not match migration 054',
    );
  }
  if (rows[0]?.pending_holds_primary_key_valid !== true) {
    throw new Error(
      'Postgres pending_unknown_cost_holds is missing its tenant-scoped primary key',
    );
  }
  if (rows[0]?.pending_holds_checks_valid !== true) {
    throw new Error(
      'Postgres pending_unknown_cost_holds is missing validated monetary or lifecycle constraints',
    );
  }
  if (rows[0]?.pending_holds_tenant_fk_valid !== true) {
    throw new Error(
      'Postgres pending_unknown_cost_holds is missing its cascading team foreign key',
    );
  }
  if (rows[0]?.pending_holds_active_index_valid !== true) {
    throw new Error(
      'Postgres pending_unknown_cost_holds is missing its validated active-state index',
    );
  }
}

// Migrations 061 and 065 establish the replica-safe budget reservation ledger
// used by daily/weekly/monthly caps (061: team + key scopes; 065: the
// per-identity scope plus its narrowing of the 061 team unique index).
// Startup verifies its live shape so a stale or partially-migrated database
// cannot admit traffic against a merely same-named relation.
const BUDGET_LEDGER_SCHEMA_QUERY = `
  WITH period_relation AS (
    SELECT to_regclass('budget_period_usage') AS oid
  ),
  reservation_relation AS (
    SELECT to_regclass('budget_reservations') AS oid
  ),
  seeded_relation AS (
    SELECT to_regclass('budget_period_seeded_requests') AS oid
  ),
  identity_caps_relation AS (
    SELECT to_regclass('identity_budget_caps') AS oid
  ),
  expected_period_columns(attname, typname, attnotnull) AS (
    VALUES
      ('id', 'text', true),
      ('team_id', 'text', true),
      ('api_key_id', 'text', false),
      ('identity_id', 'text', false),
      ('window_kind', 'text', true),
      ('period_start', 'timestamptz', true),
      ('period_end', 'timestamptz', true),
      ('reserved_microcents', 'int8', true),
      ('unknown_held_microcents', 'int8', true),
      ('actual_microcents', 'int8', true),
      ('unknown_cost_requests', 'int8', true),
      ('seeded_at', 'timestamptz', false),
      ('seeded_through', 'timestamptz', false),
      ('seeded_request_count', 'int8', true),
      ('created_at', 'timestamptz', true),
      ('updated_at', 'timestamptz', true)
  ),
  expected_reservation_columns(attname, typname, attnotnull) AS (
    VALUES
      ('id', 'text', true),
      ('period_id', 'text', true),
      ('request_id', 'text', true),
      ('team_id', 'text', true),
      ('api_key_id', 'text', false),
      ('identity_id', 'text', false),
      ('estimated_microcents', 'int8', true),
      ('actual_microcents', 'int8', true),
      ('unknown_held_microcents', 'int8', true),
      ('known_lower_bound_microcents', 'int8', false),
      ('estimate_unavailable', 'bool', true),
      ('status', 'text', true),
      ('lease_expires_at', 'timestamptz', true),
      ('dispatched_at', 'timestamptz', false),
      ('created_at', 'timestamptz', true),
      ('settled_at', 'timestamptz', false)
  ),
  expected_seeded_columns(attname, typname, attnotnull) AS (
    VALUES
      ('period_id', 'text', true),
      ('request_id', 'text', true),
      ('actual_microcents', 'int8', true),
      ('known_cost', 'bool', true),
      ('seeded_at', 'timestamptz', true)
  ),
  expected_identity_caps_columns(attname, expected_type, attnotnull) AS (
    VALUES
      ('team_id', 'text', true),
      ('identity_id', 'text', true),
      ('daily_usd_cap', 'numeric(20,8)', false),
      ('weekly_usd_cap', 'numeric(20,8)', false),
      ('monthly_usd_cap', 'numeric(20,8)', false),
      ('cap_action', 'text', true),
      ('soft_alert_at_pct', 'numeric(5,2)', false),
      ('updated_at', 'timestamp with time zone', true)
  )
  SELECT
    (
      SELECT count(*) = 2 FROM information_schema.columns
      WHERE information_schema.columns.table_name = 'team_budgets'
        AND information_schema.columns.data_type = 'numeric'
        AND information_schema.columns.numeric_precision = 20
        AND information_schema.columns.numeric_scale = 8
        AND information_schema.columns.column_name IN ('daily_usd_cap', 'weekly_usd_cap')
    ) AS team_budget_caps_columns_valid,
    (
      SELECT count(*) = 2 FROM information_schema.columns
      WHERE information_schema.columns.table_name = 'api_keys'
        AND information_schema.columns.data_type = 'numeric'
        AND information_schema.columns.numeric_precision = 20
        AND information_schema.columns.numeric_scale = 8
        AND information_schema.columns.column_name IN ('daily_usd_cap', 'weekly_usd_cap')
    ) AS api_key_budget_caps_columns_valid,
    (
      SELECT count(*) = (SELECT count(*) FROM expected_identity_caps_columns)
      FROM expected_identity_caps_columns expected
      JOIN identity_caps_relation relation ON relation.oid IS NOT NULL
      JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attname = expected.attname
       AND attribute.attnotnull = expected.attnotnull
       AND NOT attribute.attisdropped
      WHERE relation.oid IS NOT NULL
        AND format_type(attribute.atttypid, attribute.atttypmod) = expected.expected_type
    ) AS identity_budget_caps_columns_valid,
    EXISTS (
      SELECT 1
      FROM identity_caps_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'p'
       AND constraint_row.convalidated
      WHERE relation.oid IS NOT NULL
        AND array_length(constraint_row.conkey, 1) = 2
        AND constraint_row.conkey[1] = (SELECT attribute.attnum FROM pg_attribute attribute
          WHERE attribute.attrelid = relation.oid AND attribute.attname = 'team_id' AND NOT attribute.attisdropped)
        AND constraint_row.conkey[2] = (SELECT attribute.attnum FROM pg_attribute attribute
          WHERE attribute.attrelid = relation.oid AND attribute.attname = 'identity_id' AND NOT attribute.attisdropped)
    ) AS identity_budget_caps_pkey_valid,
    -- The 065 CHECKs live on SEPARATE constraints (cap_action IN-list,
    -- per-window quantization, identity nonempty), so each fragment needs its
    -- own EXISTS over the table's check constraints.
    -- 065 defines one quantization CHECK PER WINDOW (daily/weekly/monthly);
    -- pin each so a partial set cannot pass.
    EXISTS (
      SELECT 1
      FROM identity_caps_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE relation.oid IS NOT NULL
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%daily_usd_cap%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%trunc%'
    ) AS identity_budget_caps_quantization_daily_valid,
    EXISTS (
      SELECT 1
      FROM identity_caps_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE relation.oid IS NOT NULL
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%weekly_usd_cap%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%trunc%'
    ) AS identity_budget_caps_quantization_weekly_valid,
    EXISTS (
      SELECT 1
      FROM identity_caps_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE relation.oid IS NOT NULL
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%monthly_usd_cap%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%trunc%'
    ) AS identity_budget_caps_quantization_monthly_valid,
    EXISTS (
      SELECT 1
      FROM identity_caps_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE relation.oid IS NOT NULL
        AND regexp_replace(
          lower(pg_get_constraintdef(constraint_row.oid)),
          '[()"]|::[a-z0-9_]+',
          '',
          'g'
        ) ~ '^check cap_action = any array\\[''alert'', ''throttle'', ''block''\\]$'
        -- Exact-domain pin (same normalization as the 054 pending_holds
        -- checks), verified against PG 16 deparse: a constant IN-list
        -- renders as cap_action = ANY (ARRAY['alert'::text, ...]) which
        -- normalizes to 'check cap_action = any array['alert', 'throttle',
        -- 'block']' — deparse emits a space after each comma and the
        -- normalization strips parens, DOUBLE quotes, and casts, but
        -- single-quoted literals survive. Anchored ^...$ so an OR-ed
        -- extension (e.g. OR cap_action = 'allow') or a missing/reordered
        -- value fails the match: the constraint must be EXACTLY the
        -- migration's domain, not merely contain it.
    ) AS identity_budget_caps_action_valid,
    EXISTS (
      SELECT 1
      FROM identity_caps_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE relation.oid IS NOT NULL
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%length(identity_id) > 0%'
    ) AS identity_budget_caps_nonempty_valid,
    EXISTS (
      SELECT 1
      FROM identity_caps_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE relation.oid IS NOT NULL
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%soft_alert_at_pct%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%100%'
    ) AS identity_budget_caps_alert_pct_valid,
    EXISTS (
      SELECT 1
      FROM identity_caps_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.conname = 'identity_budget_caps_team_id_fkey'
       AND constraint_row.contype = 'f'
       AND constraint_row.confrelid = to_regclass('teams')
       AND constraint_row.confdeltype = 'c'
       AND constraint_row.convalidated
      WHERE relation.oid IS NOT NULL
        AND constraint_row.conkey = ARRAY[
          (SELECT attnum FROM pg_attribute WHERE attrelid = relation.oid AND attname = 'team_id')
        ]::smallint[]
        AND constraint_row.confkey = ARRAY[
          (SELECT attnum FROM pg_attribute WHERE attrelid = constraint_row.confrelid AND attname = 'id')
        ]::smallint[]
    ) AS identity_budget_caps_team_fk_valid,
    (
      SELECT count(*) = (SELECT count(*) FROM expected_period_columns)
      FROM expected_period_columns expected
      JOIN period_relation relation ON relation.oid IS NOT NULL
      JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attname = expected.attname
       AND attribute.attnotnull = expected.attnotnull
       AND NOT attribute.attisdropped
      JOIN pg_type type_row ON type_row.oid = attribute.atttypid AND type_row.typname = expected.typname
    ) AS budget_period_columns_valid,
    (
      SELECT count(*) = (SELECT count(*) FROM expected_reservation_columns)
      FROM expected_reservation_columns expected
      JOIN reservation_relation relation ON relation.oid IS NOT NULL
      JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attname = expected.attname
       AND attribute.attnotnull = expected.attnotnull
       AND NOT attribute.attisdropped
      JOIN pg_type type_row ON type_row.oid = attribute.atttypid AND type_row.typname = expected.typname
    ) AS budget_reservations_columns_valid,
    (
      SELECT count(*) = (SELECT count(*) FROM expected_seeded_columns)
      FROM expected_seeded_columns expected
      JOIN seeded_relation relation ON relation.oid IS NOT NULL
      JOIN pg_attribute attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attname = expected.attname
       AND attribute.attnotnull = expected.attnotnull
       AND NOT attribute.attisdropped
      JOIN pg_type type_row ON type_row.oid = attribute.atttypid AND type_row.typname = expected.typname
    ) AS budget_seeded_columns_valid,
    EXISTS (
      SELECT 1
      FROM period_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%daily%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%weekly%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%monthly%'
    ) AS budget_period_windows_valid,
    NOT EXISTS (
      SELECT 1
      FROM period_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
      WHERE relation.oid IS NOT NULL
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%unknown_held_microcents%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%reserved_microcents%'
    ) AS budget_period_no_forbidden_check,
    EXISTS (
      SELECT 1
      FROM reservation_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%unknown_held_microcents%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%estimated_microcents%'
    ) AS budget_reservations_held_bound_valid,
    EXISTS (
      SELECT 1
      FROM reservation_relation relation
      JOIN pg_constraint constraint_row
        ON constraint_row.conrelid = relation.oid
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
      WHERE lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%pending%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%settled%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%released%'
        AND lower(pg_get_constraintdef(constraint_row.oid)) LIKE '%unknown_held%'
    ) AS budget_reservations_status_valid,
    EXISTS (
      SELECT 1
      FROM period_relation relation
      JOIN pg_index index_row
        ON index_row.indrelid = relation.oid
       AND index_row.indisunique
       AND index_row.indisvalid
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
      WHERE index_relation.relname = 'idx_budget_period_usage_team_unique'
        AND lower(pg_get_indexdef(index_row.indexrelid)) ~ '\\(team_id, window_kind, period_start\\)'
        -- RSH-140: the 061 team index MUST be narrowed to the exact 065 shape
        -- (api_key_id IS NULL AND identity_id IS NULL). Normalize away parens
        -- (deparser adds/omits them by PG version) then compare the full
        -- predicate, so OR-ed or extra-clause drift fails.
        AND regexp_replace(lower(pg_get_expr(index_row.indpred, index_row.indrelid)), '[()]', '', 'g')
          = 'api_key_id is null and identity_id is null'
    ) AS budget_period_team_unique_valid,
    EXISTS (
      SELECT 1
      FROM period_relation relation
      JOIN pg_index index_row
        ON index_row.indrelid = relation.oid
       AND index_row.indisunique
       AND index_row.indisvalid
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
      WHERE index_relation.relname = 'idx_budget_period_usage_key_unique'
        AND lower(pg_get_indexdef(index_row.indexrelid)) LIKE '%(team_id, api_key_id, window_kind, period_start)%'
        AND lower(pg_get_expr(index_row.indpred, index_row.indrelid)) LIKE '%not null%'
    ) AS budget_period_key_unique_valid,
    EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      WHERE trigger_row.tgrelid = to_regclass('budget_period_usage')
        AND trigger_row.tgname = 'budget_period_identity_immutable_trigger'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled IN ('O', 'A') -- 'O' origin, 'A' always (both fire on origin writes)
        AND trigger_row.tgtype = 19 -- BEFORE UPDATE FOR EACH ROW
        AND trigger_row.tgqual IS NULL -- no WHEN (...) filter that could never fire
        AND cardinality(trigger_row.tgattr) = 0 -- no UPDATE OF column narrowing
        -- 065 CREATE OR REPLACEs this function to also freeze identity_id;
        -- a stale 061 body (same trigger name) must not pass. The clause
        -- checks catch 061-shaped and gutted bodies (a comment-only body
        -- that merely MENTIONS the keywords is not caught — acceptable
        -- residue for active tampering, not drift).
        AND EXISTS (
          SELECT 1 FROM pg_proc function_row
          WHERE function_row.oid = trigger_row.tgfoid
            AND function_row.proname = 'budget_period_identity_immutable'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%team_id%'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%api_key_id%'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%identity_id%'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%is distinct from%'
        )
    ) AS budget_period_immutable_trigger_valid,
    EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      WHERE trigger_row.tgrelid = to_regclass('budget_period_usage')
        AND trigger_row.tgname = 'budget_period_key_belongs_to_team_trigger'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled IN ('O', 'A') -- 'O' origin, 'A' always (both fire on origin writes)
        AND trigger_row.tgtype = 23 -- BEFORE INSERT OR UPDATE FOR EACH ROW
        AND trigger_row.tgqual IS NULL -- no WHEN (...) filter that could never fire
        AND cardinality(trigger_row.tgattr) = 0 -- no UPDATE OF column narrowing
        AND EXISTS (
          SELECT 1 FROM pg_proc function_row
          WHERE function_row.oid = trigger_row.tgfoid
            AND function_row.proname = 'budget_period_key_belongs_to_team'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%belongs to a different team%'
        )
    ) AS budget_period_key_trigger_valid,
    EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      WHERE trigger_row.tgrelid = to_regclass('budget_reservations')
        AND trigger_row.tgname = 'budget_reservation_scope_matches_period_trigger'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled IN ('O', 'A') -- 'O' origin, 'A' always (both fire on origin writes)
        AND trigger_row.tgtype = 23 -- BEFORE INSERT OR UPDATE FOR EACH ROW
        AND trigger_row.tgqual IS NULL -- no WHEN (...) filter that could never fire
        AND cardinality(trigger_row.tgattr) = 0 -- no UPDATE OF column narrowing
        -- 065 CREATE OR REPLACEs this function to also match identity_id
        -- against the referenced period row; a stale 061 body must not pass.
        AND EXISTS (
          SELECT 1 FROM pg_proc function_row
          WHERE function_row.oid = trigger_row.tgfoid
            AND function_row.proname = 'budget_reservation_scope_matches_period'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%period_team%'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%period_key%'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%period_identity%'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%is distinct from%'
        )
    ) AS budget_reservation_scope_trigger_valid,
    EXISTS (
      SELECT 1
      FROM period_relation relation
      JOIN pg_index index_row
        ON index_row.indrelid = relation.oid
       AND index_row.indisunique
       AND index_row.indisvalid
      JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
      WHERE index_relation.relname = 'idx_budget_period_usage_identity_unique'
        AND lower(pg_get_indexdef(index_row.indexrelid)) ~ '\\(team_id, identity_id, window_kind, period_start\\)'
        AND regexp_replace(lower(pg_get_expr(index_row.indpred, index_row.indrelid)), '[()]', '', 'g')
          = 'api_key_id is null and identity_id is not null'
    ) AS budget_period_identity_unique_valid,
    EXISTS (
      SELECT 1
      FROM pg_trigger trigger_row
      WHERE trigger_row.tgrelid = to_regclass('budget_period_usage')
        AND trigger_row.tgname = 'budget_period_single_scope_trigger'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled IN ('O', 'A') -- 'O' origin, 'A' always (both fire on origin writes)
        AND trigger_row.tgtype = 23 -- BEFORE INSERT OR UPDATE FOR EACH ROW
        AND trigger_row.tgqual IS NULL -- no WHEN (...) filter that could never fire
        AND cardinality(trigger_row.tgattr) = 0 -- no UPDATE OF column narrowing
        AND EXISTS (
          SELECT 1 FROM pg_proc function_row
          WHERE function_row.oid = trigger_row.tgfoid
            AND function_row.proname = 'budget_period_single_scope'
            AND lower(pg_get_functiondef(function_row.oid)) LIKE '%cannot carry both%'
        )
    ) AS budget_period_single_scope_trigger_valid
`;

/**
 * Assert that migrations 061/065's budget reservation ledger is fully
 * materialized in Postgres. Read-only: migrations own all schema changes, the
 * guard only fails fast when the ledger is missing or drifted.
 */
export async function assertPostgresBudgetLedgerSchema(): Promise<void> {
  const { rows } = await getPool().query<{
    team_budget_caps_columns_valid: boolean;
    api_key_budget_caps_columns_valid: boolean;
    identity_budget_caps_columns_valid: boolean;
    identity_budget_caps_pkey_valid: boolean;
    identity_budget_caps_quantization_daily_valid: boolean;
    identity_budget_caps_quantization_weekly_valid: boolean;
    identity_budget_caps_quantization_monthly_valid: boolean;
    identity_budget_caps_action_valid: boolean;
    identity_budget_caps_nonempty_valid: boolean;
    identity_budget_caps_alert_pct_valid: boolean;
    identity_budget_caps_team_fk_valid: boolean;
    budget_period_columns_valid: boolean;
    budget_reservations_columns_valid: boolean;
    budget_seeded_columns_valid: boolean;
    budget_period_windows_valid: boolean;
    budget_period_no_forbidden_check: boolean;
    budget_reservations_held_bound_valid: boolean;
    budget_reservations_status_valid: boolean;
    budget_period_team_unique_valid: boolean;
    budget_period_key_unique_valid: boolean;
    budget_period_immutable_trigger_valid: boolean;
    budget_period_key_trigger_valid: boolean;
    budget_reservation_scope_trigger_valid: boolean;
    budget_period_identity_unique_valid: boolean;
    budget_period_single_scope_trigger_valid: boolean;
  }>(BUDGET_LEDGER_SCHEMA_QUERY);

  if (rows[0]?.team_budget_caps_columns_valid !== true || rows[0]?.api_key_budget_caps_columns_valid !== true) {
    throw new Error(
      'Postgres budget cap columns are missing; apply migration 061 before startup',
    );
  }
  if (rows[0]?.identity_budget_caps_columns_valid !== true) {
    throw new Error(
      'Postgres identity_budget_caps columns do not match migration 065',
    );
  }
  if (rows[0]?.identity_budget_caps_pkey_valid !== true) {
    throw new Error(
      'Postgres identity_budget_caps is missing its (team_id, identity_id) primary key; apply migration 065 before startup',
    );
  }
  if (
    rows[0]?.identity_budget_caps_quantization_daily_valid !== true ||
    rows[0]?.identity_budget_caps_quantization_weekly_valid !== true ||
    rows[0]?.identity_budget_caps_quantization_monthly_valid !== true ||
    rows[0]?.identity_budget_caps_action_valid !== true ||
    rows[0]?.identity_budget_caps_nonempty_valid !== true ||
    rows[0]?.identity_budget_caps_alert_pct_valid !== true ||
    rows[0]?.identity_budget_caps_team_fk_valid !== true
  ) {
    throw new Error(
      'Postgres identity_budget_caps is missing its per-window quantization, cap_action, nonempty, alert-pct checks or team FK; apply migration 065 before startup',
    );
  }
  if (rows[0]?.budget_period_columns_valid !== true) {
    throw new Error(
      'Postgres budget_period_usage columns do not match migrations 061/065',
    );
  }
  if (rows[0]?.budget_reservations_columns_valid !== true) {
    throw new Error(
      'Postgres budget_reservations columns do not match migrations 061/065',
    );
  }
  if (rows[0]?.budget_seeded_columns_valid !== true) {
    throw new Error(
      'Postgres budget_period_seeded_requests columns do not match migration 061',
    );
  }
  if (rows[0]?.budget_period_windows_valid !== true) {
    throw new Error(
      'Postgres budget_period_usage is missing its three-window check',
    );
  }
  if (rows[0]?.budget_period_no_forbidden_check !== true) {
    throw new Error(
      'Postgres budget_period_usage has a forbidden held<=reserved relational check',
    );
  }
  if (rows[0]?.budget_reservations_held_bound_valid !== true) {
    throw new Error(
      'Postgres budget_reservations is missing its per-row unknown-held bound',
    );
  }
  if (rows[0]?.budget_reservations_status_valid !== true) {
    throw new Error(
      'Postgres budget_reservations is missing its lifecycle status check',
    );
  }
  if (rows[0]?.budget_period_team_unique_valid !== true || rows[0]?.budget_period_key_unique_valid !== true) {
    throw new Error(
      'Postgres budget_period_usage is missing its exact partial unique indexes',
    );
  }
  if (rows[0]?.budget_period_identity_unique_valid !== true) {
    throw new Error(
      'Postgres budget_period_usage is missing its identity unique index; apply migration 065 before startup',
    );
  }
  if (rows[0]?.budget_period_single_scope_trigger_valid !== true) {
    throw new Error(
      'Postgres budget_period_usage is missing its single-scope guard trigger; apply migration 065 before startup',
    );
  }
  if (
    rows[0]?.budget_period_immutable_trigger_valid !== true ||
    rows[0]?.budget_period_key_trigger_valid !== true ||
    rows[0]?.budget_reservation_scope_trigger_valid !== true
  ) {
    throw new Error(
      'Postgres budget ledger is missing its identity/scope triggers',
    );
  }
}
