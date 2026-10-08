// apps/proxy/src/logging/logger.ts
import { ClickHouseIngester } from './clickhouse.js';
import { PostgresWriter } from './postgres-writer.js';
import type { PluginRunOutcome } from '../plugins/runtime.js';

export interface RequestLogRecord {
  id: string;
  timestamp: string;
  team_id: string;
  billing_mode?: 'subscription' | 'credits';
  api_key_id?: string | null;
  layer_identity_id?: string | null;
  provider: string;
  model_requested: string;
  model_resolved: string;
  input_tokens: number;
  output_tokens: number;
  /** Provider-reported hidden reasoning tokens; absent means not reported. */
  reasoning_tokens?: number | null;
  /** Output-rate cost for reasoning tokens; null means pricing unavailable. */
  reasoning_cost_microcents?: number | null;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens: number;
  original_cost_microcents: number;
  actual_cost_microcents: number;
  /** Whether actual_cost_microcents is exact rather than a lower bound. */
  actual_cost_known: boolean;
  /** Measured plugin fee, kept separate from provider actual cost. */
  plugin_cost_microcents?: number;
  savings_microcents: number;
  total_latency_ms: number;
  ttft_ms: number | null;
  is_streaming: boolean;
  is_fallback: boolean;
  status_code: number;
  error_type?: string;
  cache_hit?: boolean;
  activity_category?: string | null;
  session_id?: string | null;
  edited_paths?: string[] | null;
  had_bash?: boolean | null;
  rate_limited?: boolean | null;
  system_prompt_tokens?: number | null;
  message_hash?: string | null;
  request_kind?: 'chat' | 'embedding';
  fallback_attempts?: Array<{ provider: string; model: string; error: string; actual_cost_known?: boolean }>;
  plugin_warnings?: Array<{ plugin: string; code: string; reason: string; message: string }>;
  /** Sanitized plugin execution audit rows. Postgres-only; never sent to ClickHouse. */
  plugin_runs?: PluginRunOutcome[];
  traceparent?: string | null;
}

function serializeFallbackAttempts(attempts: RequestLogRecord['fallback_attempts']): string {
  return JSON.stringify(attempts ?? []);
}

function serializePluginWarnings(warnings: RequestLogRecord['plugin_warnings']): string {
  return JSON.stringify(warnings ?? []);
}

function serializeEditedPaths(paths: RequestLogRecord['edited_paths']): string {
  return JSON.stringify(paths ?? []);
}

let ingester: ClickHouseIngester | null = null;
let pgWriter: PostgresWriter | null = null;

export function initLogger(): void {
  if (process.env.DATABASE_URL) {
    pgWriter = new PostgresWriter();
    console.log('Postgres request logging enabled');
  }

  const url = process.env.CLICKHOUSE_URL;
  if (url) {
    ingester = new ClickHouseIngester(url);
    // CLICKHOUSE_URL may contain userinfo or a signed endpoint. Never echo it
    // on a successful init path; an operator can inspect the configured sink
    // through deployment secrets and health state instead.
    console.log('ClickHouse logging enabled');
  }
}

export function logRequest(record: RequestLogRecord): void {
  if (pgWriter) {
    pgWriter.push(record);
  }
  if (ingester) {
    const mapped: Record<string, unknown> = {
      ...record,
      plugin_cost_microcents: record.plugin_cost_microcents ?? 0,
      fallback_attempts: serializeFallbackAttempts(record.fallback_attempts),
      plugin_warnings: serializePluginWarnings(record.plugin_warnings),
      edited_paths: serializeEditedPaths(record.edited_paths),
      had_bash: record.had_bash ? 1 : 0,
      rate_limited: record.rate_limited ? 1 : 0,
      time_to_first_token_ms: record.ttft_ms,
    };
    // ClickHouse stores the boolean as UInt8. This preserves the distinction
    // between a known zero and an unknown lower-bound cost in analytics.
    mapped.actual_cost_known = record.actual_cost_known ? 1 : 0;
    delete (mapped as any).ttft_ms;
    // plugin_runs is a relational audit stream. The ClickHouse request_logs
    // table has no nested audit column, so forwarding it would make ingestion
    // fail on an unknown field.
    delete mapped.plugin_runs;
    ingester.push(mapped);
  }
  if (!pgWriter && !ingester) {
    console.log(JSON.stringify(record));
  }
}

export async function shutdownLogger(): Promise<void> {
  if (pgWriter) await pgWriter.shutdown();
  if (ingester) await ingester.shutdown();
}

export interface LogBufferStats {
  /** Records buffered in memory, not yet persisted. */
  pending: number;
  /** Records dropped (lifetime) to keep the buffer bounded during an outage. */
  dropped: number;
}

export interface LoggerStats {
  postgres: LogBufferStats | null;
  clickhouse: LogBufferStats | null;
}

/** Snapshot of in-memory log-buffer health for /health and metrics. Reads the
 * live writer singletons; a sink that isn't configured reports null. A non-zero
 * `dropped` means request logs were lost under buffer pressure (sink outage). */
export function getLoggerStats(): LoggerStats {
  return {
    postgres: pgWriter ? { pending: pgWriter.pendingCount, dropped: pgWriter.droppedCount } : null,
    clickhouse: ingester ? { pending: ingester.pendingCount, dropped: ingester.droppedCount } : null,
  };
}
