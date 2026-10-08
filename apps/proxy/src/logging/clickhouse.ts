// apps/proxy/src/logging/clickhouse.ts

const ALLOWED_TABLES = new Set(['request_logs']);

// Bounded in-memory buffer cap. Under a prolonged ClickHouse outage we drop the
// oldest record rather than grow unbounded — but the drop is surfaced (see recordDrop).
const MAX_BUFFER_RECORDS = 50000;

export class ClickHouseIngester {
  private buffer: Record<string, unknown>[] = [];
  private flushTimer: NodeJS.Timeout;
  private flushing = false;
  private droppedTotal = 0;
  private readonly validatedTable: string;

  constructor(
    private url: string,
    table: string = 'request_logs',
    private maxSize: number = 5000,
    private flushIntervalMs: number = 5000,
    private maxBufferRecords: number = MAX_BUFFER_RECORDS,
  ) {
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`ClickHouse table '${table}' is not in the allowlist`);
    }
    this.validatedTable = table;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  /** Records held but not yet sent to ClickHouse — for healthz/metrics and tests. */
  get pendingCount(): number {
    return this.buffer.length;
  }

  /** Total records dropped to stay within the buffer cap (lifetime). */
  get droppedCount(): number {
    return this.droppedTotal;
  }

  /** Account for dropped records and surface them — a dropped log otherwise
   * reads as "ingested" downstream. Throttled so a long outage doesn't itself
   * flood the logs: emit on the first drop and each time we cross a 10k multiple
   * (handles both one-at-a-time and batch drops). */
  private recordDrop(count: number): void {
    if (count <= 0) return;
    const before = this.droppedTotal;
    this.droppedTotal += count;
    if (before === 0 || Math.floor(this.droppedTotal / 10000) > Math.floor(before / 10000)) {
      console.error(JSON.stringify({
        event: 'routeshift_clickhouse_buffer_overflow',
        dropped_total: this.droppedTotal,
        buffer_max: this.maxBufferRecords,
      }));
    }
  }

  push(record: Record<string, unknown>): void {
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
    const batch = this.buffer.splice(0);
    try {
      const body = batch.map(r => JSON.stringify(r)).join('\n');
      const query = `INSERT INTO ${this.validatedTable} FORMAT JSONEachRow`;
      const res = await fetch(
        `${this.url}/?query=${encodeURIComponent(query)}`,
        { method: 'POST', body },
      );
      if (!res.ok) {
        console.error(`ClickHouse insert failed: ${res.status} ${await res.text()}`);
        this.requeue(batch);
      }
    } catch (err) {
      console.error(`ClickHouse insert error:`, err);
      this.requeue(batch);
    } finally {
      this.flushing = false;
    }
  }

  /** Re-queue a failed batch ahead of records that arrived during the flush (the
   * batch is older). Use concat, NOT unshift(...batch): spreading a large batch
   * can RangeError on the argument count and silently lose the whole batch. Re-apply
   * the cap too — push()'s guard doesn't cover the re-queue path, so without this the
   * buffer can reach ~2x the cap on the prolonged-outage case the bound exists for.
   * Drop oldest and account for the loss so it stays observable. */
  private requeue(batch: Record<string, unknown>[]): void {
    this.buffer = batch.concat(this.buffer);
    if (this.buffer.length > this.maxBufferRecords) {
      const overflow = this.buffer.length - this.maxBufferRecords;
      this.buffer.splice(0, overflow);
      this.recordDrop(overflow);
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.flushTimer);
    await this.flush();
  }
}
