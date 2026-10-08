// apps/proxy/src/admin/team-rate-limits.ts
// LAY-348: GET/PATCH /admin/team/rate-limits?team_id=X — exposes
// teams.tpm_limit so Settings → Team rate limits can read/write the
// workspace cap. Patches invalidate the proxy-side cache so the next
// request enforces the new limit immediately.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../db/pool.js';
import { invalidateTeamTpmLimit } from '../rate-limit/team-tpm.js';

function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function handleGetTeamRateLimits(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    return fail(res, 400, 'team_id query parameter is required');
  }
  const pool = getPool();
  const { rows } = await pool.query<{ tpm_limit: number | null }>(
    `SELECT tpm_limit FROM teams WHERE id = $1`,
    [teamId],
  );
  if (rows.length === 0) {
    return fail(res, 404, 'team not found');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ tpm_limit: rows[0].tpm_limit ?? null }));
}

export async function handleUpdateTeamRateLimits(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    return fail(res, 400, 'team_id query parameter is required');
  }

  const body = await readJson(req);
  if (body === undefined) return fail(res, 400, 'invalid JSON');
  if (body === null || typeof body !== 'object') {
    return fail(res, 400, 'body must be an object');
  }
  const obj = body as Record<string, unknown>;

  // tpm_limit semantics: integer >= 1 to set a cap, null to clear.
  let nextTpm: number | null;
  if (!('tpm_limit' in obj)) {
    return fail(res, 400, 'tpm_limit is required (integer or null)');
  }
  const raw = obj.tpm_limit;
  if (raw === null) {
    nextTpm = null;
  } else if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) {
    nextTpm = raw;
  } else {
    return fail(res, 400, 'tpm_limit must be a positive integer or null');
  }

  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE teams SET tpm_limit = $2 WHERE id = $1`,
    [teamId, nextTpm],
  );
  if (!rowCount) {
    return fail(res, 404, 'team not found');
  }
  invalidateTeamTpmLimit(teamId);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ tpm_limit: nextTpm }));
}
