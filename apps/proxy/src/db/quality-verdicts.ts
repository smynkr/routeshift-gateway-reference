// apps/proxy/src/db/quality-verdicts.ts
//
// RSH-136 persistence for cascade quality verdicts: one sanitized row per
// dispatched attempt outcome (verified / quality_rejected / terminal), plus
// the rolling-window aggregation the auto-router derank consumes. Rows carry
// no prompt/response/schema/credential — they are the AttemptAudit fields.
import { randomUUID } from 'node:crypto';
import type { QualityVerdictSignal } from '@routeshift/shared';
import { getPool } from './pool.js';
import type { AttemptAudit } from '../routing/quality-cascade.js';

/**
 * Persist a cascade's audit as verdict rows. Best-effort by design: verdict
 * observability must never fail a served request (the request is already
 * settled by the time this runs) — the ENTIRE body is guarded, including pool
 * acquisition and parameter building, so no path can throw into the request.
 * Idempotent per (request_id, attempt_index) via the unique index: a retried
 * or duplicated call inserts nothing twice.
 */
export async function insertQualityVerdicts(requestId: string, audit: AttemptAudit[]): Promise<void> {
  if (audit.length === 0) return;
  try {
    const pool = getPool();
    const values: unknown[] = [];
    const placeholders: string[] = [];
    audit.forEach((row, i) => {
      const base = i * 8;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
      values.push(
        randomUUID(),
        requestId,
        row.attempt_index,
        row.provider,
        row.model,
        row.outcome,
        // pg rejects `undefined` bindings — normalize (an audit row may not
        // set reason_code/check_index for every outcome kind)
        row.reason_code ?? null,
        row.check_index ?? null,
      );
    });
    await pool.query(
      `INSERT INTO quality_verdicts
         (id, request_id, attempt_index, provider, model, outcome, reason_code, check_index)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (request_id, attempt_index) DO NOTHING`,
      values,
    );
  } catch (error) {
    console.error(`quality_verdicts insert failed for request ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Rolling-window verdict aggregates per provider:model. Counts ONLY
 * verified + quality_rejected (terminal outcomes are policy, not quality).
 * Parameterized; window bound is the shared constant's value.
 *
 * CACHED: this runs on the auto-route money path for every request when a
 * team opted into quality_derank — a per-request unbounded aggregation would
 * be a hot-path DB scan. Verdicts change slowly; the 60s cache bounds the
 * scan to once per minute per process.
 */
const VERDICT_SIGNALS_CACHE_TTL_MS = 60_000;
let verdictSignalsCache: { at: number; since: number; signals: QualityVerdictSignal[] } | null = null;

export async function getQualityVerdictSignals(since: Date): Promise<QualityVerdictSignal[]> {
  const sinceMs = since.getTime();
  if (verdictSignalsCache
    && verdictSignalsCache.since === sinceMs
    && Date.now() - verdictSignalsCache.at < VERDICT_SIGNALS_CACHE_TTL_MS) {
    return verdictSignalsCache.signals;
  }
  const pool = getPool();
  const { rows } = await pool.query<{ provider: string; model: string; verified: string; rejected: string }>(
    `SELECT provider, model,
            COUNT(*) FILTER (WHERE outcome = 'verified') AS verified,
            COUNT(*) FILTER (WHERE outcome = 'quality_rejected') AS rejected
     FROM quality_verdicts
     WHERE created_at >= $1
     GROUP BY provider, model`,
    [since],
  );
  const signals = rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    verified: Number(row.verified),
    rejected: Number(row.rejected),
  }));
  verdictSignalsCache = { at: Date.now(), since: sinceMs, signals };
  return signals;
}

/** Test seam: drop the cached aggregates so the next call re-queries. */
export function invalidateQualityVerdictSignalsCache(): void {
  verdictSignalsCache = null;
}

/**
 * Retention: verdicts older than 90 days are dead weight — the aggregation
 * reads only the 7-day window. Best-effort maintenance run by the daily
 * worker; a failure is logged, never fatal. Batched: one giant DELETE of
 * months of rows would bloat the table; bounded chunks keep each statement
 * small (10k rows, at most 100 batches).
 */
const RETENTION_BATCH_SIZE = 10_000;
const RETENTION_MAX_BATCHES = 100;

export async function retainQualityVerdicts(retainDays = 90): Promise<void> {
  try {
    const pool = getPool();
    for (let batch = 0; batch < RETENTION_MAX_BATCHES; batch += 1) {
      const { rowCount } = await pool.query(
        'DELETE FROM quality_verdicts WHERE created_at < now() - make_interval(days => $1) AND id IN '
        + '(SELECT id FROM quality_verdicts WHERE created_at < now() - make_interval(days => $1) LIMIT $2)',
        [retainDays, RETENTION_BATCH_SIZE],
      );
      if (rowCount === 0) break;
    }
  } catch (error) {
    console.error(`quality_verdicts retention failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
