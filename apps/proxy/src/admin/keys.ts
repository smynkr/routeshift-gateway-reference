// apps/proxy/src/admin/keys.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseModelSuffixes, parseUsdCap } from '@routeshift/shared';
import { getPool } from '../db/pool.js';
import { generateApiKey, invalidateKeyCache } from '../auth/api-key.js';
import { recordAuditEvent } from '../auth/audit-events.js';
import { checkLimit } from '../billing/plan-limits.js';
import { parsePresetRef, resolvePreset } from '../presets/resolver.js';
import { UUID_PATH_SEGMENT_RE } from './auth.js';

// RSH-138: per-key daily/weekly/monthly budget caps, USD parsed exactly to
// microcents. `undefined` means omitted; explicit null clears the cap.
function parseKeyBudgetCaps(body: Record<string, unknown>): Record<string, number | null | undefined> {
  const out: Record<string, number | null | undefined> = {};
  for (const field of ['daily_usd_cap', 'weekly_usd_cap', 'monthly_usd_cap'] as const) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null) {
      out[field] = null;
      continue;
    }
    const parsed = parseUsdCap(value);
    if (parsed === null) {
      throw new Error(`${field} must be a non-negative number with at most 8 decimal places, or null`);
    }
    out[field] = parsed.microcents;
  }
  return out;
}

/**
 * RSH-146: validate a mint/update `preset` binding.
 *   value undefined/null → { binding: null } (no binding)
 *   value string → parse as `<slug>` or `<slug>@<version>`; must resolve to
 *   an enabled team-scoped preset; the preset's model must be inside the
 *   key's allowed_models when an allowlist is set (else the binding is
 *   unsatisfiable: the dispatch-time allowlist check would reject the
 *   preset's own model). Returns a binding or a 400 error message.
 */
export async function resolveKeyPresetBinding(
  teamId: string,
  value: unknown,
  allowedModels: string[] | null,
): Promise<{ binding: { slug: string; version: number | null } | null; model: string | null } | { error: string }> {
  if (value === undefined || value === null) return { binding: null, model: null };
  if (typeof value !== 'string' || value.length === 0) {
    return { error: 'preset must be a preset slug (optionally @version) or null' };
  }
  const parsed = parsePresetRef(value);
  if (!parsed) {
    return { error: 'preset must be a preset slug (optionally @version) or null' };
  }
  // RSH-146: a binding is a POLICY ACT — resolution must reflect the
  // database NOW, not a ≤60s-stale cached entry (a preset disabled/deleted
  // just before mint would otherwise validate into a binding that 403s as
  // soon as the cache expires). Dispatch keeps the cache; mint does not.
  const resolved = await resolvePreset(teamId, value, { bypassCache: true });
  if (!resolved) {
    return { error: `preset_not_found: ${value}` };
  }
  // Suffix-strip the preset's model before the allowlist membership check:
  // dispatch compares the allowlist against the CANONICAL model (suffixes
  // are stripped by resolveRequestedModels), so comparing the raw suffixed
  // form here would falsely reject a preset whose model is 'gpt-5.4:floor'
  // against an allowlist of ['gpt-5.4'] — a binding mint would fail even
  // though every dispatched request would pass the same allowlist gate.
  const parsedSuffixes = parseModelSuffixes(resolved.model);
  const canonicalPresetModel = parsedSuffixes.ok ? parsedSuffixes.model : resolved.model;
  if (allowedModels && allowedModels.length > 0 && !allowedModels.includes(canonicalPresetModel)) {
    return { error: `preset model '${resolved.model}' is not in this key's allowed_models` };
  }
  return { binding: { slug: parsed.slug, version: parsed.version ?? null }, model: canonicalPresetModel };
}

export async function handleCreateKey(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }
  if (!body || typeof body !== 'object') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }

  const teamId = body.team_id;
  if (typeof teamId !== 'string' || teamId.length === 0 || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id is required' } }));
    return;
  }

  // RSH-86: defense-in-depth — if the auth middleware validated against a
  // query-string team_id (scoped tokens), the body must agree. Without this
  // check, a future allowlist expansion permitting POST for scoped tokens
  // would enable cross-tenant key creation (body.team_id ≠ query.team_id).
  const url = new URL(req.url ?? '/', 'http://localhost');
  const queryTeamId = url.searchParams.get('team_id');
  if (queryTeamId && queryTeamId !== teamId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'body team_id does not match query team_id' } }));
    return;
  }

  const limitCheck = await checkLimit(teamId, 'keys');
  if (!limitCheck.allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Plan limit reached (${limitCheck.current}/${limitCheck.limit} keys). Upgrade to create more.` },
    }));
    return;
  }

  const name = body.name ?? 'Default';
  const environment = body.environment ?? 'live';
  const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
    ? body.metadata
    : {};

  // LAY-340: optional per-key controls. Validation mirrors handleUpdateKey
  // so a Create POST and a subsequent Edit PATCH agree on what's accepted.
  let allowedModels: string[] | null = null;
  if ('allowed_models' in body && body.allowed_models !== null) {
    if (!Array.isArray(body.allowed_models) || body.allowed_models.some((m: unknown) => typeof m !== 'string')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'allowed_models must be an array of strings or null' } }));
      return;
    }
    allowedModels = body.allowed_models;
  }

  let expiresAt: Date | null = null;
  if ('expires_at' in body && body.expires_at !== null) {
    if (typeof body.expires_at !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'expires_at must be an ISO 8601 timestamp or null' } }));
      return;
    }
    const parsed = new Date(body.expires_at);
    if (Number.isNaN(parsed.getTime())) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'expires_at must be an ISO 8601 timestamp or null' } }));
      return;
    }
    expiresAt = parsed;
  }

  let rateLimitOverride: Record<string, number> | null = null;
  if ('rate_limit_override' in body && body.rate_limit_override !== null) {
    const v = body.rate_limit_override;
    if (typeof v !== 'object' || Array.isArray(v)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'rate_limit_override must be an object or null' } }));
      return;
    }
    const rpm = (v as Record<string, unknown>).requests_per_minute;
    const tpm = (v as Record<string, unknown>).tokens_per_minute;
    const validNum = (n: unknown) =>
      n === undefined || (typeof n === 'number' && Number.isFinite(n) && n > 0 && Number.isInteger(n));
    if (!validNum(rpm) || !validNum(tpm)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'rate_limit_override.{requests_per_minute,tokens_per_minute} must be positive integers' },
      }));
      return;
    }
    rateLimitOverride = v as Record<string, number>;
  }

  // RSH-138: per-key budget caps (daily/weekly/monthly USD).
  // parseKeyBudgetCaps validates to exact microcents; the columns store USD
  // decimals, so convert back for persistence (the admission service parses
  // the stored USD exactly on read).
  let budgetCaps: Record<string, number | null | undefined> = {};
  try {
    budgetCaps = parseKeyBudgetCaps(body);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: err instanceof Error ? err.message : 'Invalid budget cap' },
    }));
    return;
  }

  // RSH-146: optional org-policy preset binding (mint-time). Must resolve
  // NOW (existence + enabled + team scope + allowlist consistency); a
  // binding that cannot be satisfied at dispatch is rejected at mint.
  // The resolution and the INSERT are separate statements: a concurrent
  // disable/delete can land between them and this key is minted with a
  // binding that is already dead. Accepted semantics (not raced): the
  // outcome is identical to a disable landing one second AFTER commit —
  // inherent to mutable presets, and dispatch fails closed with
  // key_preset_unavailable (403) either way. Guarding just this window
  // would need an atomic INSERT...SELECT on both the create and rotate
  // paths without removing the post-commit case.
  let presetBinding: { slug: string; version: number | null } | null = null;
  if ('preset' in body) {
    const result = await resolveKeyPresetBinding(teamId, body.preset, allowedModels);
    if ('error' in result) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: result.error } }));
      return;
    }
    presetBinding = result.binding;
  }

  const { key, hash, prefix } = generateApiKey(teamId, environment);
  const id = randomUUID();

  const pool = getPool();
  await pool.query(
    `INSERT INTO api_keys (id, team_id, key_hash, key_prefix, name, environment, metadata,
                           allowed_models, expires_at, rate_limit_override,
                           preset_slug, preset_version,
                           daily_usd_cap, weekly_usd_cap, monthly_usd_cap)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [id, teamId, hash, prefix, name, environment, metadata,
     allowedModels, expiresAt, rateLimitOverride,
     presetBinding?.slug ?? null, presetBinding?.version ?? null,
     budgetCaps.daily_usd_cap != null ? budgetCaps.daily_usd_cap / 100_000_000 : null,
     budgetCaps.weekly_usd_cap != null ? budgetCaps.weekly_usd_cap / 100_000_000 : null,
     budgetCaps.monthly_usd_cap != null ? budgetCaps.monthly_usd_cap / 100_000_000 : null],
  );

  // LAY-331: audit-log the create. Best-effort — never blocks the response.
  void recordAuditEvent({
    team_id: teamId,
    api_key_id: id,
    key_prefix: prefix,
    event_type: 'created',
    actor_user_id: typeof body.actor_user_id === 'string' ? body.actor_user_id : null,
    details: {
      name,
      environment,
      preset_slug: presetBinding?.slug ?? null,
      preset_version: presetBinding?.version ?? null,
    },
  });

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id, key, prefix, name, environment, metadata,
    allowed_models: allowedModels,
    expires_at: expiresAt?.toISOString() ?? null,
    rate_limit_override: rateLimitOverride,
    preset_slug: presetBinding?.slug ?? null,
    preset_version: presetBinding?.version ?? null,
    daily_usd_cap: budgetCaps.daily_usd_cap != null ? budgetCaps.daily_usd_cap / 100_000_000 : null,
    weekly_usd_cap: budgetCaps.weekly_usd_cap != null ? budgetCaps.weekly_usd_cap / 100_000_000 : null,
    monthly_usd_cap: budgetCaps.monthly_usd_cap != null ? budgetCaps.monthly_usd_cap / 100_000_000 : null,
  }));
}

export async function handleListKeys(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pool = getPool();
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }
  // allowed_models + rate_limit_override MUST be selected: the dashboard edit
  // dialog round-trips whatever this listing returns, and on save it sends every
  // field back. If they're omitted here the dialog reads them as null and an
  // edit to the key's name silently clears a restricted key's model allowlist
  // and per-key rate cap (silent privilege broadening). See handleUpdateKey,
  // whose RETURNING clause already includes both columns.
  const { rows } = await pool.query(
    'SELECT id, team_id, key_prefix, name, environment, metadata, created_at, last_used, expires_at, allowed_models, rate_limit_override, preset_slug, preset_version, daily_usd_cap, weekly_usd_cap, monthly_usd_cap FROM api_keys WHERE revoked_at IS NULL AND team_id = $1 ORDER BY created_at DESC',
    [teamId],
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rows));
}

// LAY-332: PATCH /admin/keys/:id — partial update of editable columns.
// `name`, `allowed_models`, `expires_at`, `rate_limit_override`, `metadata`
// are the only fields the dashboard exposes; everything else (key_hash,
// environment, revoked_at) stays immutable post-create.
export async function handleUpdateKey(
  req: IncomingMessage,
  res: ServerResponse,
  keyId: string,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }

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

  const setExprs: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    setExprs.push(`${column} = $${params.length}`);
  };

  if ('name' in body) {
    if (typeof body.name !== 'string' || body.name.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'name must be a non-empty string' } }));
      return;
    }
    push('name', body.name);
  }

  if ('allowed_models' in body) {
    const v = body.allowed_models;
    if (v !== null && (!Array.isArray(v) || v.some((m) => typeof m !== 'string'))) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'allowed_models must be an array of strings or null' } }));
      return;
    }
    push('allowed_models', v);
  }

  if ('expires_at' in body) {
    const v = body.expires_at;
    if (v === null) {
      push('expires_at', null);
    } else if (typeof v === 'string') {
      const parsed = new Date(v);
      if (Number.isNaN(parsed.getTime())) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'expires_at must be an ISO 8601 timestamp or null' } }));
        return;
      }
      push('expires_at', parsed);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'expires_at must be an ISO 8601 timestamp or null' } }));
      return;
    }
  }

  if ('rate_limit_override' in body) {
    const v = body.rate_limit_override;
    if (v !== null) {
      if (typeof v !== 'object' || Array.isArray(v)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate_limit_override must be an object or null' } }));
        return;
      }
      const rpm = (v as Record<string, unknown>).requests_per_minute;
      const tpm = (v as Record<string, unknown>).tokens_per_minute;
      const validNum = (n: unknown) =>
        n === undefined || (typeof n === 'number' && Number.isFinite(n) && n > 0 && Number.isInteger(n));
      if (!validNum(rpm) || !validNum(tpm)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'rate_limit_override.{requests_per_minute,tokens_per_minute} must be positive integers' },
        }));
        return;
      }
    }
    push('rate_limit_override', v);
  }

  if ('metadata' in body) {
    const v = body.metadata;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'metadata must be a JSON object' } }));
      return;
    }
    push('metadata', v);
  }

  // RSH-138: per-key budget caps. Omitted fields are preserved; an explicit
  // null clears exactly that cap; values are validated exactly before SQL.
  try {
    const budgetCaps = parseKeyBudgetCaps(body);
    for (const [field, value] of Object.entries(budgetCaps)) {
      // USD columns: exact microcent validation, USD persistence.
      push(field, value != null ? value / 100_000_000 : null);
    }
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: err instanceof Error ? err.message : 'Invalid budget cap' },
    }));
    return;
  }

  // RSH-146: preset binding is editable like the other policy fields.
  // RSH-146: read-then-write is transactional — the orphan check and the
  // UPDATE must see one consistent snapshot (a concurrent preset change
  // between the check and the write would let a narrowing slip past).
  // PRESET RESOLUTION happens OUTSIDE the transaction: resolvePreset
  // acquires its own pool connections, and doing that while holding a
  // transaction client would starve the pool under concurrency.
  // ONE preflight serves both policy branches ('preset' binding edits AND
  // allowlist narrows): it reads the key's CURRENT allowed_models AND
  // binding so preflightBound is always populated for the in-tx divergence
  // check, and the bound preset's model is resolved (bypassCache) whenever
  // a narrowing could orphan it.
  const pool = getPool();
  let presetResolution: { binding: { slug: string; version: number | null } | null; model: string | null } | { error: string } | null = null;
  let orphanModel: string | undefined; // undefined = no check needed
  // Preflight binding snapshot, hoisted so the in-tx divergence check can
  // compare against it.
  let preflightBound: { preset_slug: string | null; preset_version: number | null } | null = null;
  if ('preset' in body || 'allowed_models' in body) {
    const preflight = await pool.query<{
      allowed_models: string[] | null;
      preset_slug: string | null;
      preset_version: number | null;
    }>(
      'SELECT allowed_models, preset_slug, preset_version FROM api_keys WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL',
      [keyId, teamId],
    );
    if (preflight.rows.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Key not found or already revoked' } }));
      return;
    }
    const bound = preflight.rows[0];
    preflightBound = { preset_slug: bound.preset_slug, preset_version: bound.preset_version };
    if ('preset' in body) {
      const effectiveAllowedPre = 'allowed_models' in body
        ? (body.allowed_models as string[] | null)
        : bound.allowed_models;
      presetResolution = await resolveKeyPresetBinding(teamId, body.preset, effectiveAllowedPre);
      if ('error' in presetResolution) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: presetResolution.error } }));
        return;
      }
    } else if (bound.preset_slug && Array.isArray(body.allowed_models) && body.allowed_models.length > 0) {
      // allowlist narrowing must not orphan an existing binding — resolve the
      // bound preset's model OUTSIDE the tx (honoring the PINNED version); a
      // preset that no longer resolves is already orphaned (dead binding) and
      // must not block unrelated edits. Inside the tx the model is re-checked
      // against the FOR-UPDATE snapshot.
      const boundRef = bound.preset_version != null
        ? `${bound.preset_slug}@${bound.preset_version}`
        : bound.preset_slug;
      // Policy check — bypass the 60s cache (see resolveKeyPresetBinding):
      // a stale-enabled read could admit a narrowing that orphans the
      // binding the moment the cache expires. The model is suffix-normalized
      // like mint/dispatch (a 'gpt-5.4:floor' binding against a canonical
      // allowlist is satisfiable, not an orphan).
      const resolved = await resolvePreset(teamId, boundRef, { bypassCache: true });
      if (resolved) {
        const parsedOrphan = parseModelSuffixes(resolved.model);
        orphanModel = parsedOrphan.ok ? parsedOrphan.model : resolved.model;
      }
      // resolved === null → dead binding → orphanModel stays undefined → no check
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: current } = await client.query<{
      allowed_models: string[] | null;
      preset_slug: string | null;
      preset_version: number | null;
    }>(
      'SELECT allowed_models, preset_slug, preset_version FROM api_keys WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL FOR UPDATE',
      [keyId, teamId],
    );
    if (current.length === 0) {
      await client.query('ROLLBACK');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Key not found or already revoked' } }));
      return;
    }
    const effectiveAllowed = 'allowed_models' in body
      ? (body.allowed_models as string[] | null)
      : current[0].allowed_models;

    if (presetResolution) {
      push('preset_slug', presetResolution.binding?.slug ?? null);
      push('preset_version', presetResolution.binding?.version ?? null);
      // The preflight allowlist may be stale (a concurrent narrowing can land
      // between the preflight and this FOR-UPDATE lock). Re-check the
      // binding's model against the SNAPSHOT's effective allowlist so a
      // binding outside the allowlist can never be committed (it would 403
      // every dispatch — a bricked key).
      if (presetResolution.binding && presetResolution.model
          && effectiveAllowed && effectiveAllowed.length > 0
          && !effectiveAllowed.includes(presetResolution.model)) {
        await client.query('ROLLBACK');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: `preset model '${presetResolution.model}' is not in this key's allowed_models` },
        }));
        return;
      }
    } else if ('allowed_models' in body && Array.isArray(body.allowed_models) && body.allowed_models.length > 0) {
      // Narrowing path — must not orphan a binding. The FOR-UPDATE snapshot
      // is authoritative: if its binding differs from the preflight's (a
      // concurrent PATCH changed the binding between preflight and lock),
      // the preflight-resolved model is untrustworthy. Resolving inside the
      // tx would hold a client while resolvePreset waits for another (pool
      // starvation under concurrent updates), so fail closed with 409 — the
      // caller retries against the committed state.
      // Coverage note: this guard catches binding-IDENTITY races (slug/
      // version). The MODEL of an unpinned (version-less) binding can still
      // drift between preflight and commit without slug/version changing —
      // that is the inherent mutable-latest semantics documented on the mint
      // path; dispatch fails closed with key_preset_unavailable/mismatch
      // either way.
      const snapshotBinding = current[0].preset_slug != null;
      const preflightHadBinding = preflightBound?.preset_slug != null;
      const bindingChanged = snapshotBinding !== preflightHadBinding
        || (snapshotBinding && (current[0].preset_slug !== preflightBound?.preset_slug || current[0].preset_version !== preflightBound?.preset_version));
      if (bindingChanged) {
        await client.query('ROLLBACK');
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'Key binding changed concurrently; retry the update', code: 'key_concurrent_modification' },
        }));
        return;
      }
      if (orphanModel !== undefined && effectiveAllowed && !effectiveAllowed.includes(orphanModel)) {
        await client.query('ROLLBACK');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: `allowed_models would orphan the key's preset binding: preset model '${orphanModel}' is not in this key's allowed_models` },
        }));
        return;
      }
    }

    if (setExprs.length === 0) {
      await client.query('ROLLBACK');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'No updatable fields provided' } }));
      return;
    }

    params.push(keyId, teamId);
    const sql = `
      UPDATE api_keys
         SET ${setExprs.join(', ')}
       WHERE id = $${params.length - 1} AND team_id = $${params.length} AND revoked_at IS NULL
       RETURNING id, team_id, key_hash, key_prefix, name, environment,
                 allowed_models, expires_at, rate_limit_override, metadata,
                 preset_slug, preset_version,
                 daily_usd_cap, weekly_usd_cap, monthly_usd_cap,
                 created_at, last_used
    `;

    const { rows } = await client.query(sql, params);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Key not found or already revoked' } }));
      return;
    }

    await client.query('COMMIT');

    const updated = rows[0];
    invalidateKeyCache(updated.key_hash);

    // RSH-146: org-policy changes (incl. preset binding edits) are audited.
    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyId,
      key_prefix: updated.key_prefix,
      event_type: 'updated',
      actor_user_id: typeof body.actor_user_id === 'string' ? body.actor_user_id : null,
      details: {
        changed_fields: setExprs.map((expr) => expr.split(' ')[0]),
        preset_slug: updated.preset_slug ?? null,
        preset_version: updated.preset_version ?? null,
      },
    });

    // Strip the hash before returning — it's a secret derivative we never expose.
    const { key_hash: _hash, ...safe } = updated;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // the original error is the one that matters
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function handleRevokeKey(req: IncomingMessage, res: ServerResponse, keyId: string): Promise<void> {
  // team_id is optional for service-admin revocation. Axiom Layer only stores
  // RouteShift key IDs, not the RouteShift tenant ID, so admin-authenticated
  // DELETE /admin/keys/:id must remain idempotent without a query param. When
  // team_id is provided, keep the stricter scoped update.
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id wildcard is not allowed' } }));
    return;
  }
  const actorUserId = url.searchParams.get('actor_user_id');

  const pool = getPool();
  const scoped = typeof teamId === 'string' && teamId.length > 0;
  const { rows, rowCount } = await pool.query(
    scoped
      ? 'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL RETURNING team_id, key_hash, key_prefix'
      : 'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING team_id, key_hash, key_prefix',
    scoped ? [keyId, teamId] : [keyId],
  );
  if (rowCount === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Key not found or already revoked' } }));
    return;
  }
  invalidateKeyCache(rows[0].key_hash);

  // LAY-331: audit-log the revoke.
  void recordAuditEvent({
    team_id: rows[0].team_id,
    api_key_id: keyId,
    key_prefix: rows[0].key_prefix,
    event_type: 'revoked',
    actor_user_id: actorUserId,
    details: {},
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ revoked: true }));
}

// LAY-339: POST /admin/keys/:id/rotate?team_id=...
// Mints a new key for the same team + environment as the old one and
// puts the old one inside a grace window so callers can roll over without
// dropping live traffic. validateApiKey honors `rotation_grace_until` so
// the old key keeps working until the window closes.
const DEFAULT_GRACE_HOURS = 24;
const MAX_GRACE_HOURS = 168; // 7 days

export async function handleRotateKey(
  req: IncomingMessage,
  res: ServerResponse,
  keyId: string,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }
  const actorUserId = url.searchParams.get('actor_user_id');

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any = {};
  // Empty bodies are explicitly allowed — POST /rotate with no payload
  // means "use the default grace window". Only parse when bytes arrived.
  const raw = Buffer.concat(chunks).toString();
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
      return;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
      return;
    }
  }

  // grace_hours is optional. Bound it tightly — a grace window longer than
  // a week defeats the rotation hygiene the feature exists for.
  let graceHours: number = DEFAULT_GRACE_HOURS;
  if ('grace_hours' in body) {
    const v = body.grace_hours;
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      !Number.isInteger(v) ||
      v < 1 ||
      v > MAX_GRACE_HOURS
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `grace_hours must be an integer between 1 and ${MAX_GRACE_HOURS}` },
      }));
      return;
    }
    graceHours = v;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the old key to keep concurrent rotations on the same key from
    // racing each other. The team scope is part of the predicate so we
    // can't accidentally rotate someone else's key.
    const { rows: oldRows } = await client.query<{
      id: string;
      key_hash: string;
      key_prefix: string;
      environment: string;
      allowed_models: string[] | null;
      rate_limit_override: Record<string, number> | null;
      metadata: Record<string, unknown> | null;
      preset_slug: string | null;
      preset_version: number | null;
      expires_at: Date | null;
      daily_usd_cap: string | null;
      weekly_usd_cap: string | null;
      monthly_usd_cap: string | null;
    }>(
      `SELECT id, key_hash, key_prefix, environment, allowed_models, rate_limit_override, metadata,
              preset_slug, preset_version, expires_at,
              daily_usd_cap, weekly_usd_cap, monthly_usd_cap
         FROM api_keys
        WHERE id = $1 AND team_id = $2 AND revoked_at IS NULL
        FOR UPDATE`,
      [keyId, teamId],
    );
    if (oldRows.length === 0) {
      await client.query('ROLLBACK');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Key not found or already revoked' } }));
      return;
    }
    const oldKey = oldRows[0]!;

    // RSH-100: SSO-issued keys are short-lived by design (default 8h) and
    // rotating one would collide with idx_api_keys_one_live_sso_per_identity
    // -- that index requires the old row to be revoked before a replacement
    // with the same (team_id, email, issued_via) can be inserted, but
    // grace-period rotation deliberately keeps the old row non-revoked
    // through its grace window. Reject rather than reconciling the two:
    // an 8h key doesn't need manual rotation, and the default 24h grace
    // window would itself outlive the key's own TTL anyway.
    if (oldKey.metadata?.issued_via === 'sso_device_flow') {
      await client.query('ROLLBACK');
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'SSO-issued keys self-expire and cannot be rotated; re-authenticate via SSO to obtain a new one.' },
      }));
      return;
    }

    const environment = oldKey.environment === 'test' ? 'test' : 'live';
    const { key: newKey, hash: newHash, prefix: newPrefix } = generateApiKey(teamId, environment);
    const newId = randomUUID();

    // Carry the original key's restrictions onto the rotated key. Rotation is
    // credential hygiene, NOT a scope downgrade: dropping allowed_models /
    // rate_limit_override / metadata / preset binding / budget caps / expiry
    // would silently widen a restricted key (any-model access, default rate
    // caps, unbound, uncapped, never-expiring) — the exact "silent privilege
    // broadening" handleListKeys already guards against. Fail closed: a
    // restricted key in → an equally-restricted key out.
    await client.query(
      `INSERT INTO api_keys (id, team_id, key_hash, key_prefix, name, environment,
                             allowed_models, rate_limit_override, metadata,
                             preset_slug, preset_version, expires_at,
                             daily_usd_cap, weekly_usd_cap, monthly_usd_cap)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [newId, teamId, newHash, newPrefix, 'Rotated key', environment,
       oldKey.allowed_models, oldKey.rate_limit_override, oldKey.metadata,
       oldKey.preset_slug, oldKey.preset_version, oldKey.expires_at,
       oldKey.daily_usd_cap, oldKey.weekly_usd_cap, oldKey.monthly_usd_cap],
    );

    // Stamp the old key with the rotation pointer + grace window.
    const { rows: updatedRows } = await client.query<{ rotation_grace_until: string }>(
      `UPDATE api_keys
          SET rotated_to_id = $1,
              rotation_grace_until = now() + ($2 || ' hours')::interval
        WHERE id = $3 AND team_id = $4
        RETURNING rotation_grace_until`,
      [newId, String(graceHours), keyId, teamId],
    );

    await client.query('COMMIT');

    // Drop the old key from the in-process cache so the next request
    // re-reads the fresh rotation_grace_until — the cache row was loaded
    // before this column was set.
    invalidateKeyCache(oldKey.key_hash);

    void recordAuditEvent({
      team_id: teamId,
      api_key_id: keyId,
      key_prefix: oldKey.key_prefix,
      event_type: 'rotated',
      actor_user_id: actorUserId,
      details: {
        new_key_id: newId,
        new_key_prefix: newPrefix,
        grace_hours: graceHours,
        preset_slug: oldKey.preset_slug,
        preset_version: oldKey.preset_version,
      },
    });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      new_key_id: newId,
      new_key: newKey,
      new_prefix: newPrefix,
      environment,
      grace_until: updatedRows[0]?.rotation_grace_until ?? null,
      preset_slug: oldKey.preset_slug,
      preset_version: oldKey.preset_version,
      daily_usd_cap: oldKey.daily_usd_cap != null ? Number(oldKey.daily_usd_cap) : null,
      weekly_usd_cap: oldKey.weekly_usd_cap != null ? Number(oldKey.weekly_usd_cap) : null,
      monthly_usd_cap: oldKey.monthly_usd_cap != null ? Number(oldKey.monthly_usd_cap) : null,
    }));
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore secondary rollback failures
    }
    console.error('rotate-key: failed:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Failed to rotate key' } }));
  } finally {
    client.release();
  }
}

// LAY-331: GET /admin/keys/:id/audit?team_id=...&limit=N
// Returns the most recent audit events for a single key. The drawer in
// /keys uses this to surface "who revoked this", "when did the leaked
// prefix get tried", "did this key hit its budget recently".
const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;
// Shared with the scoped-admin gate in admin/auth.ts so the allowlist and the
// handler can never drift on what a canonical UUID path segment is.

export async function handleListKeyAudit(
  req: IncomingMessage,
  res: ServerResponse,
  keyId: string,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }
  // The database column is uuid-typed. Validate the router-provided path id
  // before binding it so malformed (including double-encoded) path segments
  // fail closed with a deterministic client error instead of a DB 500.
  if (!UUID_PATH_SEGMENT_RE.test(keyId)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'key_id must be a valid UUID' } }));
    return;
  }
  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, AUDIT_MAX_LIMIT)
      : AUDIT_DEFAULT_LIMIT;

  const pool = getPool();
  // Query by api_key_id only — auth_failed rows that matched this key's
  // prefix have api_key_id=null and live on the team-wide audit view
  // (separate ticket).
  const { rows } = await pool.query(
    `SELECT id, event_type, actor_user_id, details, created_at
     FROM api_key_audit_events
     WHERE team_id = $1 AND api_key_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [teamId, keyId, limit],
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events: rows }));
}

// LAY-347: GET /admin/keys/audit?team_id=...&event_type=...&actor=...
//   &key_prefix=...&from=...&to=...&limit=N&cursor=...
// Workspace-wide audit feed across every key in the team, including the
// auth_failed rows whose api_key_id is NULL (prefix didn't match a real key).
// Cursor-paginated by (created_at, id) so a follow-up page deterministically
// continues past the last row regardless of same-instant duplicates.
const TEAM_AUDIT_DEFAULT_LIMIT = 50;
const TEAM_AUDIT_MAX_LIMIT = 200;
const TEAM_AUDIT_EVENT_TYPES = new Set([
  'created',
  'revoked',
  'rotated',
  'updated',
  'auth_failed',
  'rate_limited',
  'budget_exceeded',
  'sso_issued',
]);

export async function handleListTeamAudit(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'team_id query parameter is required' } }));
    return;
  }

  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, TEAM_AUDIT_MAX_LIMIT)
      : TEAM_AUDIT_DEFAULT_LIMIT;

  const params: unknown[] = [teamId];
  const where: string[] = ['team_id = $1'];

  const eventType = url.searchParams.get('event_type');
  if (eventType) {
    // Reject unknown values instead of silently dropping the filter: an
    // ignored filter would return the entire unfiltered team feed, widening
    // the result past what the caller asked for. The seven canonical values
    // are pinned by TEAM_AUDIT_EVENT_TYPES (migration 025 + 046 constraint).
    if (!TEAM_AUDIT_EVENT_TYPES.has(eventType)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unsupported event_type: ${eventType}` } }));
      return;
    }
    params.push(eventType);
    where.push(`event_type = $${params.length}`);
  }

  const actor = url.searchParams.get('actor');
  if (actor) {
    params.push(actor);
    where.push(`actor_user_id = $${params.length}`);
  }

  const keyPrefix = url.searchParams.get('key_prefix');
  if (keyPrefix) {
    // Escape LIKE metacharacters so a caller-supplied prefix is matched
    // literally — an unescaped `%`/`_` (or `\`) would widen the filter beyond a
    // real prefix. Admin-gated and team-scoped, so low severity, but a `%`
    // would otherwise return the whole team's audit feed.
    const escapedPrefix = keyPrefix.replace(/[\\%_]/g, '\\$&');
    params.push(`${escapedPrefix}%`);
    where.push(`key_prefix LIKE $${params.length} ESCAPE '\\'`);
  }

  const fromRaw = url.searchParams.get('from');
  if (fromRaw) {
    const from = new Date(fromRaw);
    if (!Number.isNaN(from.getTime())) {
      params.push(from.toISOString());
      where.push(`created_at >= $${params.length}`);
    }
  }

  const toRaw = url.searchParams.get('to');
  if (toRaw) {
    const to = new Date(toRaw);
    if (!Number.isNaN(to.getTime())) {
      params.push(to.toISOString());
      where.push(`created_at < $${params.length}`);
    }
  }

  const cursorRaw = url.searchParams.get('cursor');
  if (cursorRaw) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
      // Validate the decoded values are a real date + uuid BEFORE binding them to
      // the ::timestamptz/::uuid casts. A syntactically-string-but-invalid value
      // (e.g. created_at:'not-a-date') passes a typeof check but makes Postgres
      // throw "invalid input syntax" → an unhandled 500. Mirror the clean-ignore
      // pattern in admin/sessions.ts and the dashboard demo audit route: a
      // malformed cursor is simply dropped (no cursor predicate).
      if (
        typeof decoded?.created_at === 'string' &&
        typeof decoded?.id === 'string' &&
        !Number.isNaN(Date.parse(decoded.created_at)) &&
        UUID_PATH_SEGMENT_RE.test(decoded.id)
      ) {
        params.push(decoded.created_at);
        params.push(decoded.id);
        where.push(
          `(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
    } catch {
      // ignore malformed cursors
    }
  }

  params.push(limit + 1);
  const sql = `
    SELECT id, api_key_id, key_prefix, event_type, actor_user_id, details, created_at
      FROM api_key_audit_events
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}
  `;

  const pool = getPool();
  const { rows } = await pool.query(sql, params);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({ created_at: last.created_at.toISOString(), id: last.id }),
          'utf8',
        ).toString('base64url')
      : null;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events: page, next_cursor: nextCursor }));
}
