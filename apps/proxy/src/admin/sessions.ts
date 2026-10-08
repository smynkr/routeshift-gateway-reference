// Admin endpoint for Layer's yield-analysis worker (LAY-311).
// Returns a paginated window of session_metrics so the correlator can
// match RouteShift sessions against Layer-tracked git commits offline,
// without exposing per-team API keys.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../db/pool.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionRow {
  session_id: string;
  team_id: string;
  edit_turns: number;
  retry_turns: number;
  one_shot_rate: string | number | null;
  primary_model: string | null;
  total_cost_microcents: string | number | bigint;
  billed_cost_microcents: string | number | bigint;
  unknown_cost_requests: number;
  first_request_at: Date;
  last_request_at: Date;
}

export function encodeCursor(last_request_at: Date, session_id: string): string {
  const payload = JSON.stringify({
    last_request_at: last_request_at.toISOString(),
    session_id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { last_request_at: Date; session_id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (typeof parsed?.last_request_at !== 'string' || typeof parsed?.session_id !== 'string') {
      return null;
    }
    const ts = new Date(parsed.last_request_at);
    if (Number.isNaN(ts.getTime())) return null;
    return { last_request_at: ts, session_id: parsed.session_id };
  } catch {
    return null;
  }
}

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

export async function handleSessionsWindow(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  const limitRaw = url.searchParams.get('limit');
  const cursorRaw = url.searchParams.get('cursor');
  const teamId = url.searchParams.get('team_id');

  if (!teamId) {
    return fail(res, 400, 'team_id is required');
  }
  if (teamId === '*') {
    return fail(res, 400, 'team_id must be a concrete team id');
  }

  const from = fromRaw ? new Date(fromRaw) : null;
  if (!from || Number.isNaN(from.getTime())) {
    return fail(res, 400, 'from is required (ISO 8601 timestamp)');
  }
  const to = toRaw ? new Date(toRaw) : null;
  if (!to || Number.isNaN(to.getTime())) {
    return fail(res, 400, 'to is required (ISO 8601 timestamp)');
  }
  if (from.getTime() >= to.getTime()) {
    return fail(res, 400, 'from must be earlier than to');
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return fail(res, 400, 'window cannot exceed 7 days');
  }

  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = Number(limitRaw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return fail(res, 400, 'limit must be a positive integer');
    }
    limit = Math.min(Math.floor(parsed), MAX_LIMIT);
  }

  let cursor: { last_request_at: Date; session_id: string } | null = null;
  if (cursorRaw) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) {
      return fail(res, 400, 'cursor is malformed');
    }
  }

  const params: unknown[] = [from, to, teamId];
  let where = 'last_request_at >= $1 AND last_request_at < $2 AND team_id = $3';
  if (cursor) {
    params.push(cursor.last_request_at, cursor.session_id);
    where += ` AND (last_request_at, session_id) > ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);
  const sql = `
    SELECT session_id, team_id, edit_turns, retry_turns, one_shot_rate,
           primary_model, total_cost_microcents, billed_cost_microcents, unknown_cost_requests,
           first_request_at, last_request_at
      FROM session_metrics
     WHERE ${where}
     ORDER BY last_request_at ASC, session_id ASC
     LIMIT $${params.length}
  `;

  const pool = getPool();
  const { rows } = await pool.query<SessionRow>(sql, params);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const next_cursor =
    hasMore && last ? encodeCursor(last.last_request_at, last.session_id) : null;

  const sessions = page.map((r) => ({
    session_id: r.session_id,
    team_id: r.team_id,
    edit_turns: r.edit_turns,
    retry_turns: r.retry_turns,
    one_shot_rate: r.one_shot_rate == null ? null : Number(r.one_shot_rate),
    primary_model: r.primary_model,
    total_cost_microcents: String(r.total_cost_microcents),
    billed_cost_microcents: String(r.billed_cost_microcents),
    unknown_cost_requests: Number(r.unknown_cost_requests ?? 0),
    first_request_at: r.first_request_at.toISOString(),
    last_request_at: r.last_request_at.toISOString(),
  }));

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ sessions, next_cursor }));
}
