// apps/proxy/src/admin/auto-route.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPool } from '../db/pool.js';
import type { AutoRouteSettings } from '../routing/auto-router.js';

const settingsCache = new Map<string, { settings: AutoRouteSettings; expires: number }>();
const CACHE_TTL_MS = 30_000;

export async function getAutoRouteSettings(teamId: string): Promise<AutoRouteSettings> {
  const cached = settingsCache.get(teamId);
  if (cached && cached.expires > Date.now()) {
    return cached.settings;
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT enabled, strategy, max_fallbacks, quality_derank FROM team_auto_route_settings WHERE team_id = $1`,
    [teamId],
  );

  if (rows.length === 0) {
    const defaults: AutoRouteSettings = { enabled: false, strategy: 'balanced', max_fallbacks: 2, quality_derank: false };
    settingsCache.set(teamId, { settings: defaults, expires: Date.now() + CACHE_TTL_MS });
    return defaults;
  }

  const settings: AutoRouteSettings = {
    enabled: rows[0].enabled,
    strategy: rows[0].strategy,
    max_fallbacks: rows[0].max_fallbacks,
    quality_derank: rows[0].quality_derank === true,
  };
  settingsCache.set(teamId, { settings, expires: Date.now() + CACHE_TTL_MS });
  return settings;
}

export function invalidateAutoRouteCache(teamId: string): void {
  settingsCache.delete(teamId);
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

export async function handleInvalidateAutoRouteSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }
  const teamId = typeof body?.team_id === 'string' ? body.team_id : null;
  if (!teamId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id is required' } }));
    return;
  }
  invalidateAutoRouteCache(teamId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ invalidated: true }));
}

export async function handleGetAutoRouteSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const teamId = url.searchParams.get('team_id');
  if (!teamId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }

  const settings = await getAutoRouteSettings(teamId);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(settings));
}

export async function handleUpdateAutoRouteSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: any;
  try {
    body = await readJsonBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const teamId = url.searchParams.get('team_id');
  if (!teamId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }

  const enabled = Boolean(body.enabled);
  const strategy = body.strategy === 'cheapest' || body.strategy === 'fastest' ? body.strategy : 'balanced';
  // Only a JSON number that is a true integer may reach the SQL bind
  // (pg would 500 on a fractional/NaN value, and Number() coercion would
  // admit true/false/'5' — false -> 0 would silently disable fallbacks).
  // Anything else falls back to the default, matching the handler's
  // invalid-input posture (bad strategy silently defaults).
  const rawMaxFallbacks = body.max_fallbacks;
  const maxFallbacks = typeof rawMaxFallbacks === 'number' && Number.isInteger(rawMaxFallbacks)
    ? Math.min(5, Math.max(0, rawMaxFallbacks))
    : 2;
  // RSH-136: preserve the opt-in flag when the client omits it (undefined OR
  // explicit JSON null) — a full-replace here would silently reset deranking
  // for saves that do not carry the field (matches the dashboard route).
  // Only a literal boolean is accepted: any other value (string, number)
  // preserves the existing flag rather than silently disabling an opt-in.
  const qualityDerank = body.quality_derank === true || body.quality_derank === false
    ? body.quality_derank
    : null;

  const pool = getPool();
  await pool.query(
    `INSERT INTO team_auto_route_settings (team_id, enabled, strategy, max_fallbacks, quality_derank, updated_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, false), now())
     ON CONFLICT (team_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       strategy = EXCLUDED.strategy,
       max_fallbacks = EXCLUDED.max_fallbacks,
       quality_derank = COALESCE($5, team_auto_route_settings.quality_derank),
       updated_at = now()`,
    [teamId, enabled, strategy, maxFallbacks, qualityDerank],
  );

  invalidateAutoRouteCache(teamId);

  // Return the EFFECTIVE flag (preserved value when omitted) so the response
  // is truthful for every caller.
  const { rows: stored } = await pool.query<{ quality_derank: boolean }>(
    'SELECT quality_derank FROM team_auto_route_settings WHERE team_id = $1',
    [teamId],
  );
  const effectiveQualityDerank = stored[0]?.quality_derank === true;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    enabled,
    strategy,
    max_fallbacks: maxFallbacks,
    quality_derank: effectiveQualityDerank,
  }));
}
