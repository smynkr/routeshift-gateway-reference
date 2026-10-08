// LAY-331: api_keys lifecycle audit events.
//
// Every audit-worthy action (key created/revoked, failed-auth attempts,
// rate-limit and budget hits) writes a row to api_key_audit_events. The
// emit path is best-effort — an audit insert failure must NEVER block the
// request that triggered it. We log and move on.
//
// auth_failed emission is rate-limited per (team, prefix) to once per
// minute. A leaked-key brute-force attempt would otherwise saturate the
// table; one row per minute is enough to detect the pattern without
// runaway storage.

import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';

export type AuditEventType =
  | 'created'
  | 'revoked'
  | 'rotated'
  | 'updated'
  | 'auth_failed'
  | 'rate_limited'
  | 'budget_exceeded'
  | 'sso_issued';

export interface AuditEventInput {
  team_id: string;
  api_key_id: string | null;
  key_prefix: string | null;
  event_type: AuditEventType;
  actor_user_id?: string | null;
  details?: Record<string, unknown>;
}

const AUTH_FAIL_DEDUP_MS = 60 * 1000;
const recentAuthFailures = new Map<string, number>();

export async function recordAuditEvent(input: AuditEventInput): Promise<void> {
  if (input.event_type === 'auth_failed') {
    const key = `${input.team_id}:${input.key_prefix ?? ''}`;
    const last = recentAuthFailures.get(key);
    const now = Date.now();
    if (last !== undefined && now - last < AUTH_FAIL_DEDUP_MS) return;
    recentAuthFailures.set(key, now);
    // Reap stale dedup entries opportunistically — keeps the map bounded
    // even under prefix-spraying attacks.
    if (recentAuthFailures.size > 1000) {
      const cutoff = now - AUTH_FAIL_DEDUP_MS;
      for (const [k, t] of recentAuthFailures) {
        if (t < cutoff) recentAuthFailures.delete(k);
      }
    }
  }

  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO api_key_audit_events
         (id, team_id, api_key_id, key_prefix, event_type, actor_user_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        randomUUID(),
        input.team_id,
        input.api_key_id,
        input.key_prefix,
        input.event_type,
        input.actor_user_id ?? null,
        input.details ?? {},
      ],
    );
  } catch (err) {
    console.warn('audit-events: insert failed (non-fatal):', err);
  }
}

/** @internal — for testing only */
export function _resetAuthFailureDedup(): void {
  recentAuthFailures.clear();
}
