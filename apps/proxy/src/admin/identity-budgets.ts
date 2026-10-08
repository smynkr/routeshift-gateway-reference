// apps/proxy/src/admin/identity-budgets.ts
//
// RSH-140: per-identity budget caps (per-person ceilings across a person's
// keys). GET reads one identity's caps or the team's identity list; PUT
// upserts/clears one identity's caps with the exact-decimal USD parser the
// team/key cap surfaces use.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseUsdCap } from '@routeshift/shared';
import { getPool } from '../db/pool.js';

export const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** RSH-140: admission-side identity sanity gate — a malformed
 *  layer_identity_id must not silently create an unenforceable identity
 *  scope (a key whose metadata identity can never match a configured cap
 *  would fail open past its person's ceiling). Invalid => no identity. */
export function isValidIdentityId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && IDENTITY_RE.test(value);
}
const CAP_FIELDS = ['daily_usd_cap', 'weekly_usd_cap', 'monthly_usd_cap'] as const;

/**
 * Exact microcents -> USD decimal spelling via integer arithmetic (never a
 * binary-float division): 9006320389700102 -> '90063203.89700102'. The
 * spelling is what numeric(20,8) stores verbatim, so the DB cap equals the
 * exact value the caller sent.
 */
export function microcentsToUsdSpelling(microcents: number): string {
  const sign = microcents < 0 ? '-' : '';
  const abs = Math.abs(microcents);
  const intPart = Math.floor(abs / 100_000_000);
  const fracPart = abs % 100_000_000;
  return fracPart === 0
    ? `${sign}${intPart}`
    : `${sign}${intPart}.${String(fracPart).padStart(8, '0')}`;
}

function identityFromQuery(url: URL, res: ServerResponse): string | null {
  const identityId = url.searchParams.get('identity_id');
  if (!identityId || !IDENTITY_RE.test(identityId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'identity_id is required' } }));
    return null;
  }
  return identityId;
}

export async function handleListIdentityBudgets(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT identity_id, daily_usd_cap, weekly_usd_cap, monthly_usd_cap, cap_action, soft_alert_at_pct, updated_at
       FROM identity_budget_caps WHERE team_id = $1 ORDER BY identity_id`,
    [teamId],
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rows));
}

export async function handleGetIdentityBudget(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }
  const identityId = identityFromQuery(url, res);
  if (!identityId) return;

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT identity_id, daily_usd_cap, weekly_usd_cap, monthly_usd_cap, cap_action, soft_alert_at_pct, updated_at
       FROM identity_budget_caps WHERE team_id = $1 AND identity_id = $2`,
    [teamId, identityId],
  );
  if (rows.length === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No identity budget caps configured' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rows[0]));
}

export async function handlePutIdentityBudget(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }
  const identityId = identityFromQuery(url, res);
  if (!identityId) return;

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }

  // Exact-decimal USD parsing (same contract as the team/key cap surfaces):
  // null clears a cap; values must be non-negative with <= 8 decimals.
  // The cap is bound as its EXACT decimal spelling — converting microcents
  // through a JS float (microcents / 100_000_000) before binding numeric(20,8)
  // round-trips through binary float and can drop a microcent from the stored
  // cap (e.g. 90063203.89700102 -> 90063203.89700101), skewing boundary
  // admission against the exact value the caller sent.
  const caps: Record<string, string | null> = {};
  for (const field of CAP_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null) {
      caps[field] = null;
      continue;
    }
    const parsed = parseUsdCap(raw);
    if (parsed === null) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `${field} must be a non-negative number with at most 8 decimal places, or null` },
      }));
      return;
    }
    caps[field] = microcentsToUsdSpelling(parsed.microcents);
  }

  const VALID_ACTIONS = ['alert', 'throttle', 'block'] as const;
  if ('cap_action' in body && !(VALID_ACTIONS as readonly string[]).includes(body.cap_action)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: "cap_action must be 'alert', 'throttle', or 'block'" } }));
    return;
  }
  const capAction = body.cap_action === 'throttle' || body.cap_action === 'block' ? body.cap_action : 'alert';
  const alertPct = body.soft_alert_at_pct == null
    ? null
    : typeof body.soft_alert_at_pct === 'number' && body.soft_alert_at_pct >= 0 && body.soft_alert_at_pct <= 100
      ? body.soft_alert_at_pct
      : null;
  if (body.soft_alert_at_pct != null && alertPct === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'soft_alert_at_pct must be a number between 0 and 100, or null' } }));
    return;
  }

  if (!('daily_usd_cap' in body) && !('weekly_usd_cap' in body) && !('monthly_usd_cap' in body)
      && !('cap_action' in body) && !('soft_alert_at_pct' in body)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No updatable fields provided' } }));
    return;
  }
  const pool = getPool();
  // Preserve-when-absent, clear-when-explicit-null: the SET clause is built
  // from exactly the fields present in the body (a partial update never wipes
  // the caps it never mentioned; an explicit null clears that one field).
  const setExprs: string[] = [];
  const params: unknown[] = [teamId, identityId];
  const push = (column: string, value: unknown) => {
    params.push(value);
    setExprs.push(`${column} = $${params.length}`);
  };
  if ('daily_usd_cap' in body) push('daily_usd_cap', caps.daily_usd_cap ?? null);
  if ('weekly_usd_cap' in body) push('weekly_usd_cap', caps.weekly_usd_cap ?? null);
  if ('monthly_usd_cap' in body) push('monthly_usd_cap', caps.monthly_usd_cap ?? null);
  if ('cap_action' in body) push('cap_action', capAction);
  if ('soft_alert_at_pct' in body) push('soft_alert_at_pct', alertPct);
  await pool.query(
    `INSERT INTO identity_budget_caps (team_id, identity_id, daily_usd_cap, weekly_usd_cap, monthly_usd_cap, cap_action, soft_alert_at_pct, updated_at)
     VALUES ($1, $2, NULL, NULL, NULL, 'alert', NULL, now())
     ON CONFLICT (team_id, identity_id) DO UPDATE SET
       ${setExprs.join(', ')},
       updated_at = now()`,
    params,
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    identity_id: identityId,
    ...('daily_usd_cap' in body ? { daily_usd_cap: caps.daily_usd_cap ?? null } : {}),
    ...('weekly_usd_cap' in body ? { weekly_usd_cap: caps.weekly_usd_cap ?? null } : {}),
    ...('monthly_usd_cap' in body ? { monthly_usd_cap: caps.monthly_usd_cap ?? null } : {}),
    ...('cap_action' in body ? { cap_action: capAction } : {}),
    ...('soft_alert_at_pct' in body ? { soft_alert_at_pct: alertPct } : {}),
  }));
}
