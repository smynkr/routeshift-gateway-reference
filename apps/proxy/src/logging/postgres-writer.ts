import { getPool } from '../db/pool.js';
import type { RequestLogRecord } from './logger.js';

// Bounded in-memory buffer cap. Under a prolonged DB outage we drop the oldest
// record rather than grow unbounded — but the drop is surfaced (see recordDrop).
const MAX_BUFFER_RECORDS = 50000;
const SAFE_PLUGIN_DETAIL = /^[a-z0-9_:-]{1,120}$/;

function stablePluginDetail(detail: string | undefined): string | null {
  return detail && SAFE_PLUGIN_DETAIL.test(detail) ? detail : null;
}

export class PostgresWriter {
  private buffer: RequestLogRecord[] = [];
  private flushTimer: NodeJS.Timeout;
  private flushing = false;
  private droppedTotal = 0;

  constructor(
    private maxSize: number = 50,
    private flushIntervalMs: number = 2000,
    private maxBufferRecords: number = MAX_BUFFER_RECORDS,
  ) {
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  /** Records held but not yet persisted — for healthz/metrics and tests. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** Total records dropped to stay within the buffer cap (lifetime). */
  get droppedCount(): number {
    return this.droppedTotal;
  }

  /** Account for dropped records and surface them — a dropped log otherwise
   * reads as "persisted" downstream. Throttled so a long outage doesn't itself
   * flood the logs: emit on the first drop and each time we cross a 10k multiple
   * (handles both one-at-a-time and batch drops). */
  private recordDrop(count: number): void {
    if (count <= 0) return;
    const before = this.droppedTotal;
    this.droppedTotal += count;
    if (before === 0 || Math.floor(this.droppedTotal / 10000) > Math.floor(before / 10000)) {
      console.error(JSON.stringify({
        event: 'routeshift_pg_log_buffer_overflow',
        dropped_total: this.droppedTotal,
        buffer_max: this.maxBufferRecords,
      }));
    }
  }

  push(record: RequestLogRecord): void {
    if (this.buffer.length >= this.maxBufferRecords) {
      this.buffer.shift(); // drop oldest to stay bounded
      this.recordDrop(1);
    }
    this.buffer.push(record);
    if (this.buffer.length >= this.maxSize) this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const columns = [
        'id',
        'timestamp',
        'team_id',
        'billing_mode',
        'api_key_id',
        'provider',
        'model_requested',
        'model_resolved',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'total_tokens',
        'original_cost_microcents',
        'actual_cost_microcents',
        'actual_cost_known',
        'plugin_cost_microcents',
        'savings_microcents',
        'total_latency_ms',
        'ttft_ms',
        'is_streaming',
        'is_fallback',
        'status_code',
        'error_type',
        'cache_hit',
        'activity_category',
        'session_id',
        'edited_paths',
        'had_bash',
        'rate_limited',
        'system_prompt_tokens',
        'message_hash',
        'request_kind',
        'fallback_attempts',
        'plugin_warnings',
        'traceparent',
        'layer_identity_id',
        'reasoning_tokens',
        'reasoning_cost_microcents',
      ];

      const values: unknown[] = [];
      const rows: string[] = [];

      for (let i = 0; i < batch.length; i++) {
        const r = batch[i]!;
        const offset = i * columns.length;
        const placeholders = columns.map((_, j) => `$${offset + j + 1}`);
        rows.push(`(${placeholders.join(', ')})`);
        values.push(
          r.id,
          r.timestamp,
          r.team_id,
          r.billing_mode ?? 'subscription',
          r.api_key_id ?? null,
          r.provider,
          r.model_requested,
          r.model_resolved,
          r.input_tokens,
          r.output_tokens,
          r.cache_read_tokens ?? 0,
          r.cache_write_tokens ?? 0,
          r.total_tokens,
          r.original_cost_microcents,
          r.actual_cost_microcents,
          r.actual_cost_known,
          r.plugin_cost_microcents ?? 0,
          r.savings_microcents,
          r.total_latency_ms,
          r.ttft_ms,
          r.is_streaming,
          r.is_fallback,
          r.status_code,
          r.error_type ?? null,
          r.cache_hit ?? false,
          r.activity_category ?? null,
          r.session_id ?? null,
          r.edited_paths ?? null,
          r.had_bash ?? null,
          r.rate_limited ?? false,
          r.system_prompt_tokens ?? null,
          r.message_hash ?? null,
          r.request_kind ?? 'chat',
          JSON.stringify(r.fallback_attempts ?? []),
          JSON.stringify(r.plugin_warnings ?? []),
          r.traceparent ?? null,
          // Empty string (not NULL) is the "known unattributed" sentinel,
          // matching ClickHouse: rollup queries treat '' as no-fallback,
          // reserving NULL for pre-migration rows that may legitimately
          // fall back to current key metadata (AXI-8).
          r.layer_identity_id ?? '',
          r.reasoning_tokens ?? null,
          r.reasoning_cost_microcents ?? null,
        );
      }

      const sql = `INSERT INTO request_logs (${columns.join(', ')}) VALUES ${rows.join(', ')} ON CONFLICT (id) DO NOTHING`;
      await getPool().query(sql, values);

      const pluginRuns = batch.flatMap((record) => (
        record.plugin_runs?.map((run) => ({ record, run })) ?? []
      ));
      if (pluginRuns.length > 0) {
        const pluginRunColumns = [
          'id',
          'request_id',
          'team_id',
          'plugin_id',
          'status',
          'cost_microcents',
          'latency_ms',
          'detail',
        ];
        const pluginRunValues: unknown[] = [];
        const pluginRunRows: string[] = [];
        for (let i = 0; i < pluginRuns.length; i++) {
          const { record, run } = pluginRuns[i]!;
          const offset = i * pluginRunColumns.length;
          pluginRunRows.push(`(${pluginRunColumns.map((_, j) => `$${offset + j + 1}`).join(', ')})`);
          // Plugin specs are de-duplicated by id per request. The deterministic
          // id plus the database conflict target makes a retry after a partial
          // logger flush exactly-once rather than producing duplicate audits.
          pluginRunValues.push(
            `prun_${record.id}_${run.plugin}`,
            record.id,
            record.team_id,
            run.plugin,
            run.status,
            Math.max(0, run.costMicrocents),
            Math.max(0, run.latencyMs),
            stablePluginDetail(run.detail),
          );
        }
        const pluginRunSql = `INSERT INTO plugin_runs (${pluginRunColumns.join(', ')}) VALUES ${pluginRunRows.join(', ')} ON CONFLICT (request_id, plugin_id) DO NOTHING`;
        await getPool().query(pluginRunSql, pluginRunValues);
      }
    } catch (err) {
      console.error('Postgres request_logs insert error:', err);
      // Re-queue the failed batch in front (it's older than anything that
      // arrived during the flush). Use concat, NOT unshift(...batch): spreading
      // a large batch can RangeError on the arg count and silently lose it all.
      this.buffer = batch.concat(this.buffer);
      // Re-apply the cap here too — push()'s guard doesn't cover the re-queue,
      // so without this the buffer can reach ~2x the cap on the failure path
      // (exactly the prolonged-outage case the bound exists for). Drop oldest
      // and account for it so the loss stays observable.
      if (this.buffer.length > this.maxBufferRecords) {
        const overflow = this.buffer.length - this.maxBufferRecords;
        this.buffer.splice(0, overflow);
        this.recordDrop(overflow);
      }
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}
