// LAY-311: nightly correlator that joins RouteShift sessions with Layer git
// commits to label each session productive / reverted / abandoned.
//
// Window: yesterday's closed sessions (24h ago → now), since a session is only
// labelable once 24h have passed (a commit reverted-soon needs the full window
// to settle). Runs hourly so a session that closes at 02:00 doesn't have to
// wait until midnight to get its yield label — the same session is harmless
// to relabel because the upsert is idempotent and the source data only moves
// from "no commit" → "commit" → "reverted".
//
// Auth into Layer: x-internal-api-token: $LAYER_INTERNAL_API_TOKEN. If the
// env var is missing, the correlator no-ops with a warn. We do NOT silently
// skip sessions; if Layer is reachable but returns no commits for a tenant,
// every session in the window is labelled `abandoned`.
//
// Replica-safe via pg_try_advisory_xact_lock(YIELD_CORRELATOR_LOCK_ID = 3).

import { getPool } from '../db/pool.js';

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1h
const LABEL_WINDOW_HOURS = 24;
const LABEL_LAG_MS = LABEL_WINDOW_HOURS * 60 * 60 * 1000;
const LOOKBACK_DAYS = 7;
const SESSION_BATCH_LIMIT = 500;
const YIELD_CORRELATOR_LOCK_ID = 3;

let timer: ReturnType<typeof setInterval> | null = null;

interface TeamRow {
  team_id: string;
  layer_tenant_id: string;
}

interface SessionRow {
  session_id: string;
  team_id: string;
  last_request_at: Date;
}

interface LayerCommit {
  sha: string;
  repo: string;
  branch: string | null;
  author_email: string;
  author_name: string | null;
  committed_at: string;
  merged_to_main_at: string | null;
  reverted_by_sha: string | null;
  reverted_at: string | null;
}

export function startYieldCorrelator(): void {
  setTimeout(() => {
    void refreshYield();
  }, 30_000);
  timer = setInterval(() => {
    void refreshYield();
  }, REFRESH_INTERVAL_MS);
  timer.unref();
  console.log('[yield-correlator] started (1h interval)');
}

export function stopYieldCorrelator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function refreshYield(): Promise<{ sessions_labeled: number; teams_processed: number }> {
  const layerToken = process.env.LAYER_INTERNAL_API_TOKEN;
  const layerBase = process.env.LAYER_BASE_URL;
  if (!layerToken || layerToken.length < 32 || !layerBase) {
    console.warn('[yield-correlator] LAYER_INTERNAL_API_TOKEN or LAYER_BASE_URL missing; skipping');
    return { sessions_labeled: 0, teams_processed: 0 };
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockRes = await client.query<{ pg_try_advisory_xact_lock: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1)',
      [YIELD_CORRELATOR_LOCK_ID],
    );
    if (!lockRes.rows[0]?.pg_try_advisory_xact_lock) {
      await client.query('ROLLBACK');
      return { sessions_labeled: 0, teams_processed: 0 };
    }

    // Layer mints RouteShift keys with `team_id: opts.tenantId` (see
    // axiomlayer/apps/axiom-layer/src/lib/routeshift-admin.ts), so for
    // Layer-issued teams `teams.id` IS the Layer tenant UUID — no manual
    // mapping required. teams.layer_tenant_id stays as an optional override
    // for any team whose id isn't itself a UUID (e.g. legacy "team_dev").
    const teams = await client.query<TeamRow>(
      `SELECT id AS team_id,
              COALESCE(layer_tenant_id::text, id) AS layer_tenant_id
         FROM teams
        WHERE layer_tenant_id IS NOT NULL
           OR id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    );

    let totalLabeled = 0;
    let teamsProcessed = 0;

    for (const team of teams.rows) {
      // Only label sessions whose 24h window has fully elapsed. Anything
      // newer can't be definitively `abandoned` yet.
      const sessions = await client.query<SessionRow>(
        `SELECT m.session_id, m.team_id, m.last_request_at
           FROM session_metrics m
           LEFT JOIN session_yield y ON y.team_id = m.team_id AND y.session_id = m.session_id
          WHERE m.team_id = $1
            AND m.last_request_at >= NOW() - make_interval(days => $2)
            AND m.last_request_at < NOW() - make_interval(secs => $3)
            AND (y.session_id IS NULL OR y.session_ended_at < m.last_request_at)
          ORDER BY m.last_request_at ASC
          LIMIT $4`,
        [team.team_id, LOOKBACK_DAYS, Math.floor(LABEL_LAG_MS / 1000), SESSION_BATCH_LIMIT],
      );

      if (sessions.rows.length === 0) continue;
      teamsProcessed++;

      const fromTime = new Date(
        sessions.rows[0]!.last_request_at.getTime(),
      );
      const toTime = new Date(
        sessions.rows[sessions.rows.length - 1]!.last_request_at.getTime() + LABEL_LAG_MS,
      );

      let commits: LayerCommit[] = [];
      try {
        const url = new URL('/api/internal/git-commits', layerBase);
        url.searchParams.set('tenant_id', team.layer_tenant_id);
        url.searchParams.set('from', fromTime.toISOString());
        url.searchParams.set('to', toTime.toISOString());
        const res = await fetch(url, {
          headers: { 'x-internal-api-token': layerToken },
        });
        if (!res.ok) {
          console.warn(
            `[yield-correlator] Layer responded ${res.status} for team=${team.team_id}; skipping`,
          );
          continue;
        }
        const body = (await res.json()) as { commits?: LayerCommit[] };
        commits = body.commits ?? [];
      } catch (err) {
        console.warn(
          `[yield-correlator] fetch failed for team=${team.team_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      // Sort commits by committed_at so we can take the earliest match per
      // session deterministically.
      commits.sort((a, b) =>
        new Date(a.committed_at).getTime() - new Date(b.committed_at).getTime(),
      );

      for (const session of sessions.rows) {
        const sessionEnd = session.last_request_at.getTime();
        const windowEnd = sessionEnd + LABEL_LAG_MS;

        const match = commits.find((c) => {
          const at = new Date(c.committed_at).getTime();
          if (at < sessionEnd || at > windowEnd) return false;
          // v1: any merged commit counts. If merged_to_main_at is null we
          // treat it as not-yet-shipped which → abandoned for now.
          return c.merged_to_main_at !== null;
        });

        let label: 'productive' | 'reverted' | 'abandoned';
        let matchedSha: string | null = null;
        let matchedRepo: string | null = null;
        let matchedAt: string | null = null;
        let revertedAt: string | null = null;

        if (!match) {
          label = 'abandoned';
        } else {
          matchedSha = match.sha;
          matchedRepo = match.repo;
          matchedAt = match.merged_to_main_at;
          if (match.reverted_at) {
            const revertedAtMs = new Date(match.reverted_at).getTime();
            // Per ticket: reverted within 24h of session end is `reverted`;
            // after 24h the commit stays productive.
            if (revertedAtMs - sessionEnd <= LABEL_LAG_MS) {
              label = 'reverted';
              revertedAt = match.reverted_at;
            } else {
              label = 'productive';
            }
          } else {
            label = 'productive';
          }
        }

        await client.query(
          `INSERT INTO session_yield (
             session_id, team_id, label, matched_commit_sha, matched_commit_repo,
             matched_commit_at, reverted_at, session_ended_at, computed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (team_id, session_id) DO UPDATE SET
             label = EXCLUDED.label,
             matched_commit_sha = EXCLUDED.matched_commit_sha,
             matched_commit_repo = EXCLUDED.matched_commit_repo,
             matched_commit_at = EXCLUDED.matched_commit_at,
             reverted_at = EXCLUDED.reverted_at,
             session_ended_at = EXCLUDED.session_ended_at,
             computed_at = NOW()`,
          [
            session.session_id,
            session.team_id,
            label,
            matchedSha,
            matchedRepo,
            matchedAt,
            revertedAt,
            session.last_request_at,
          ],
        );
        totalLabeled++;
      }
    }

    await client.query('COMMIT');
    if (totalLabeled > 0) {
      console.log(
        `[yield-correlator] labeled ${totalLabeled} sessions across ${teamsProcessed} teams`,
      );
    }
    return { sessions_labeled: totalLabeled, teams_processed: teamsProcessed };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[yield-correlator] unhandled error', err);
    return { sessions_labeled: 0, teams_processed: 0 };
  } finally {
    client.release();
  }
}
