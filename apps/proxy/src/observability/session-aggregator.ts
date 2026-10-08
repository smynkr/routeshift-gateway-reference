// LAY-314 phase 3: per-session one-shot / retry-rate aggregation cron.
//
// Walks closed sessions (last activity ≥30 min ago) every 5 min and upserts
// the precomputed metrics into session_metrics. The pure algorithm lives
// in session-stats.ts so the aggregation is unit-testable without pg.
//
// Replica-safe: each run holds pg_try_advisory_xact_lock(SESSION_AGG_LOCK_ID),
// distinct from other proxy crons (savings reporter uses 1, auto-topup
// uses no lock).

import { getPool } from '../db/pool.js';
import { computeSessionStats, type TurnRow } from './session-stats.js';

export { computeSessionStats } from './session-stats.js';
export type { SessionStats, TurnRow } from './session-stats.js';

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SESSION_IDLE_CUTOFF_MIN = 30;
const SESSION_AGG_LOCK_ID = 2;
const SESSION_BATCH_LIMIT = 500;

let timer: ReturnType<typeof setInterval> | null = null;

export function startSessionAggregator(): void {
  setTimeout(() => {
    void refreshSessionMetrics();
  }, 10_000);
  timer = setInterval(() => {
    void refreshSessionMetrics();
  }, REFRESH_INTERVAL_MS);
  timer.unref();
  console.log('[session-aggregator] started (5min interval)');
}

export function stopSessionAggregator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function refreshSessionMetrics(): Promise<{ sessions_processed: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockRes = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1)',
      [SESSION_AGG_LOCK_ID],
    );
    if (!lockRes.rows[0]?.pg_try_advisory_xact_lock) {
      await client.query('ROLLBACK');
      return { sessions_processed: 0 };
    }

    // Closed sessions that haven't been computed yet, or whose latest
    // request post-dates the last computation (defensive — sessions stay
    // closed once idle, but a manual reset of session_metrics needs to
    // re-aggregate).
    const candidates = await client.query<{ team_id: string; session_id: string }>(
      `
      SELECT r.team_id, r.session_id
      FROM (
        SELECT team_id, session_id, MAX(timestamp) AS last_at
        FROM request_logs
        WHERE session_id IS NOT NULL
        GROUP BY team_id, session_id
      ) r
      LEFT JOIN session_metrics m ON m.team_id = r.team_id AND m.session_id = r.session_id
      WHERE r.last_at < NOW() - make_interval(mins => $1)
        AND (m.session_id IS NULL OR m.last_request_at < r.last_at)
      LIMIT $2
      `,
      [SESSION_IDLE_CUTOFF_MIN, SESSION_BATCH_LIMIT],
    );

    let processed = 0;
    for (const { team_id, session_id } of candidates.rows) {
      const turnsRes = await client.query<TurnRow>(
        `
        SELECT timestamp, model_resolved, edited_paths, had_bash,
               actual_cost_microcents, actual_cost_known,
               COALESCE(plugin_cost_microcents, 0) AS plugin_cost_microcents
        FROM request_logs
        WHERE session_id = $1 AND team_id = $2
        ORDER BY timestamp ASC
        `,
        [session_id, team_id],
      );

      const stats = computeSessionStats(turnsRes.rows);

      await client.query(
        `
        INSERT INTO session_metrics (
          session_id, team_id, edit_turns, retry_turns, one_shot_rate,
          primary_model, total_cost_microcents, billed_cost_microcents,
          unknown_cost_requests, first_request_at, last_request_at, computed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (team_id, session_id) DO UPDATE SET
          edit_turns = EXCLUDED.edit_turns,
          retry_turns = EXCLUDED.retry_turns,
          one_shot_rate = EXCLUDED.one_shot_rate,
          primary_model = EXCLUDED.primary_model,
          total_cost_microcents = EXCLUDED.total_cost_microcents,
          billed_cost_microcents = EXCLUDED.billed_cost_microcents,
          unknown_cost_requests = EXCLUDED.unknown_cost_requests,
          first_request_at = EXCLUDED.first_request_at,
          last_request_at = EXCLUDED.last_request_at,
          computed_at = NOW()
        `,
        [
          session_id,
          team_id,
          stats.edit_turns,
          stats.retry_turns,
          stats.one_shot_rate,
          stats.primary_model,
          stats.total_cost_microcents.toString(),
          stats.billed_cost_microcents.toString(),
          stats.unknown_cost_requests,
          stats.first_request_at,
          stats.last_request_at,
        ],
      );
      processed++;
    }

    await client.query('COMMIT');
    if (processed > 0) {
      console.log(`[session-aggregator] processed ${processed} sessions`);
    }
    return { sessions_processed: processed };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('[session-aggregator] error:', err);
    return { sessions_processed: 0 };
  } finally {
    client.release();
  }
}
