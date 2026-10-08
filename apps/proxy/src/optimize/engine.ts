// LAY-315 optimize engine: runs every rule for every team nightly,
// upserts any findings into optimize_findings, and auto-resolves findings
// the rules no longer detect after 48h. Replica-safe via
// pg_try_advisory_xact_lock(OPTIMIZE_LOCK_ID). Each background job MUST own a
// DISTINCT advisory lock id — session aggregator (2), yield correlator (3),
// orphan-key sweeper (4), optimize engine (5). This was previously 3, which
// the yield correlator (also 3) grabbed first in the boot race, so the failed
// try-lock rolled back and the first optimize scan was silently skipped for the
// full ~24h interval after every deploy.

import { getPool } from '../db/pool.js';
import { lowCacheHitRule } from './rules/low-cache-hit.js';
import { wrongModelForCategoryRule } from './rules/wrong-model-for-category.js';
import { alwaysFailingPrimaryRule } from './rules/always-failing-primary.js';
import { oversizedSystemPromptRule } from './rules/oversized-system-prompt.js';
import { duplicateRequestsRule } from './rules/duplicate-requests.js';
import type { Rule } from './types.js';

const OPTIMIZE_LOCK_ID = 5;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 7;
const AUTO_RESOLVE_AFTER_HOURS = 48;

export const RULES: Rule[] = [
  lowCacheHitRule,
  wrongModelForCategoryRule,
  alwaysFailingPrimaryRule,
  oversizedSystemPromptRule,
  duplicateRequestsRule,
];

let timer: ReturnType<typeof setInterval> | null = null;

export function startOptimizeEngine(): void {
  setTimeout(() => {
    void runOptimizeEngine();
  }, 30_000);
  timer = setInterval(() => {
    void runOptimizeEngine();
  }, RUN_INTERVAL_MS);
  timer.unref();
  console.log('[optimize-engine] started (24h interval)');
}

export function stopOptimizeEngine(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function runOptimizeEngine(): Promise<{ teams_scanned: number; findings_upserted: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1)',
      [OPTIMIZE_LOCK_ID],
    );
    if (!lock.rows[0]?.pg_try_advisory_xact_lock) {
      await client.query('ROLLBACK');
      return { teams_scanned: 0, findings_upserted: 0 };
    }

    // Scan teams that have any traffic in the lookback. A team with zero
    // traffic produces zero findings — no point running rules on it.
    const teamRes = await client.query<{ team_id: string }>(
      `
      SELECT DISTINCT team_id
      FROM request_logs
      WHERE timestamp >= NOW() - make_interval(days => $1)
      `,
      [LOOKBACK_DAYS],
    );

    let upserted = 0;

    for (const { team_id } of teamRes.rows) {
      for (const rule of RULES) {
        try {
          const finding = await rule.detect({ pool, teamId: team_id, lookbackDays: LOOKBACK_DAYS });
          if (!finding) continue;

          await client.query(
            `
            INSERT INTO optimize_findings (
              team_id, rule_id, severity, estimated_savings_microcents,
              body_md, fix_md, status, first_seen_at, last_seen_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'open', NOW(), NOW())
            ON CONFLICT (team_id, rule_id) DO UPDATE SET
              severity = EXCLUDED.severity,
              estimated_savings_microcents = EXCLUDED.estimated_savings_microcents,
              body_md = EXCLUDED.body_md,
              fix_md = EXCLUDED.fix_md,
              status = CASE
                WHEN optimize_findings.status = 'dismissed' THEN 'dismissed'
                ELSE 'open'
              END,
              last_seen_at = NOW(),
              resolved_at = NULL
            `,
            [
              team_id,
              finding.rule_id,
              finding.severity,
              finding.estimated_savings_microcents.toString(),
              finding.body_md,
              finding.fix_md,
            ],
          );
          upserted++;
        } catch (err) {
          console.error(`[optimize-engine] rule ${rule.id} failed for team ${team_id}:`, err);
        }
      }
    }

    // Auto-resolve findings the rule no longer fires for. We only resolve
    // findings that are at least AUTO_RESOLVE_AFTER_HOURS old since their
    // last sighting — i.e. the rule has had time to re-fire if it was
    // going to.
    await client.query(
      `
      UPDATE optimize_findings
      SET status = 'resolved', resolved_at = NOW()
      WHERE status = 'open'
        AND last_seen_at < NOW() - make_interval(hours => $1)
      `,
      [AUTO_RESOLVE_AFTER_HOURS],
    );

    await client.query('COMMIT');
    if (upserted > 0) {
      console.log(`[optimize-engine] scanned ${teamRes.rows.length} teams, upserted ${upserted} findings`);
    }
    return { teams_scanned: teamRes.rows.length, findings_upserted: upserted };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    console.error('[optimize-engine] error:', err);
    return { teams_scanned: 0, findings_upserted: 0 };
  } finally {
    client.release();
  }
}
