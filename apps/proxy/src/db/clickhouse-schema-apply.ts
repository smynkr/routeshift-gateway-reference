// ClickHouse has no migration runner alongside Postgres migrations. Keep the
// additive request-log column application explicit and execute it before the
// logger can enqueue a record that depends on the column.

import { clickHouseQueryUrl } from '../usage/clickhouse.js';

const ADD_PLUGIN_COST_COLUMN =
  'ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS plugin_cost_microcents Int64 DEFAULT 0 AFTER actual_cost_microcents';
const ADD_ACTUAL_COST_KNOWN_COLUMN =
  'ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS actual_cost_known UInt8 DEFAULT 1 AFTER actual_cost_microcents';
const ADD_REASONING_TOKENS_COLUMN =
  'ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS reasoning_tokens Nullable(UInt32) DEFAULT NULL AFTER output_tokens';
const ADD_REASONING_COST_COLUMN =
  'ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS reasoning_cost_microcents Nullable(Int64) DEFAULT NULL AFTER reasoning_tokens';


/**
 * Apply the additive Track-D request-log column to a configured ClickHouse
 * sink. This deliberately fails startup rather than enabling an ingester that
 * will reject, requeue, and eventually drop every plugin-aware request log.
 * The query is static and the error is sanitized so a credential-bearing
 * CLICKHOUSE_URL or server response never reaches application logs.
 */
export async function ensureClickHousePluginCostColumn(clickhouseUrl: string): Promise<void> {
  await ensureColumn(clickhouseUrl, ADD_PLUGIN_COST_COLUMN, 'add_plugin_cost_microcents', 'plugin billing logging');
}

/** Apply all request-log columns emitted by the current logger before startup. */
export async function ensureClickHouseRequestLogColumns(clickhouseUrl: string): Promise<void> {
  await ensureClickHousePluginCostColumn(clickhouseUrl);
  await ensureColumn(clickhouseUrl, ADD_ACTUAL_COST_KNOWN_COLUMN, 'add_actual_cost_known', 'unknown-cost logging');
  await ensureColumn(clickhouseUrl, ADD_REASONING_TOKENS_COLUMN, 'add_reasoning_tokens', 'reasoning analytics');
  await ensureColumn(clickhouseUrl, ADD_REASONING_COST_COLUMN, 'add_reasoning_cost_microcents', 'reasoning analytics');
}

async function ensureColumn(
  clickhouseUrl: string,
  query: string,
  operation: string,
  feature: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(clickHouseQueryUrl(clickhouseUrl, query, {}), {
      method: 'POST',
    });
  } catch {
    console.error(JSON.stringify({
      event: 'routeshift_clickhouse_schema_apply_failed',
      operation,
      reason: 'request_failed',
    }));
    throw new Error(`ClickHouse request_logs schema is unavailable; ${feature} cannot start`);
  }

  if (!response.ok) {
    console.error(JSON.stringify({
      event: 'routeshift_clickhouse_schema_apply_failed',
      operation,
      status: response.status,
    }));
    throw new Error(`ClickHouse request_logs schema rejected ${feature}`);
  }
}
