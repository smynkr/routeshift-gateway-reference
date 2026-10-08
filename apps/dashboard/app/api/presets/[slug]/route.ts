import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { EFFECTIVE_DISPATCHABLE_CHAT_MODELS, parseModelSuffixes, parseProviderPreferences } from '@routeshift/shared';
import { getPool } from '@/lib/db';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { normalizePresetParams, validateReasoningParams } from '@/lib/reasoning-params';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CANONICAL_NAMES = new Set(EFFECTIVE_DISPATCHABLE_CHAT_MODELS.map((model) => model.canonical_name));
const PRESET_CACHE_TTL_SECONDS = 60;

interface PresetBody {
  model?: unknown;
  params?: unknown;
  system_prompt?: unknown;
  provider_prefs?: unknown;
  enabled?: unknown;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function validModel(model: string): boolean {
  if (CANONICAL_NAMES.has(model)) return true;
  const parsed = parseModelSuffixes(model);
  return parsed.ok && CANONICAL_NAMES.has(parsed.model);
}

type ProxyCacheInvalidation = {
  proxy_cache_invalidated: boolean;
  proxy_cache_error?: 'proxy_cache_invalidation_failed';
  cache_ttl_seconds?: number;
};

async function bustProxyCache(teamId: string): Promise<ProxyCacheInvalidation> {
  try {
    const response = await fetch(`${PROXY_URL}/admin/presets/invalidate`, {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ team_id: teamId }),
    });
    if (!response.ok) {
      console.warn('Preset cache invalidation returned non-OK status:', response.status);
      return {
        proxy_cache_invalidated: false,
        proxy_cache_error: 'proxy_cache_invalidation_failed',
        cache_ttl_seconds: PRESET_CACHE_TTL_SECONDS,
      };
    }
    return { proxy_cache_invalidated: true };
  } catch (err) {
    console.warn('Preset cache invalidation failed after committed write:', err);
    return {
      proxy_cache_invalidated: false,
      proxy_cache_error: 'proxy_cache_invalidation_failed',
      cache_ttl_seconds: PRESET_CACHE_TTL_SECONDS,
    };
  }
}

function adminSecretErrorResponse(): Response | null {
  try {
    assertAdminSecret();
    return null;
  } catch (err) {
    console.error('presets admin proxy configuration error:', err);
    return NextResponse.json({ error: 'proxy_admin_secret_not_configured' }, { status: 500 });
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const member = await requireTeamMembership();
  if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { slug } = await params;
  if (!validSlug(slug)) return NextResponse.json({ error: 'invalid_preset_slug' }, { status: 400 });
  const teamId = (await getEffectiveTeamId(member.teamId)) as string;

  const { rows } = await getPool().query(
    `SELECT slug, version, model, params, system_prompt, provider_prefs, enabled, updated_at
     FROM presets
     WHERE team_id = $1 AND slug = $2`,
    [teamId, slug],
  );
  const preset = rows[0];
  if (!preset) return NextResponse.json({ error: 'preset_not_found' }, { status: 404 });
  return NextResponse.json({ preset });
}

export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (await isDemoActive()) {
    return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
  }
  const user = await requireRole('admin');
  if (!user) return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
  const adminSecretError = adminSecretErrorResponse();
  if (adminSecretError) return adminSecretError;
  const { slug } = await params;
  if (!validSlug(slug)) return NextResponse.json({ error: 'invalid_preset_slug' }, { status: 400 });

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!isRecord(parsed)) {
    return NextResponse.json({ error: 'Invalid preset body' }, { status: 400 });
  }
  const body = parsed as PresetBody;

  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!validModel(model)) {
    return NextResponse.json({ error: 'invalid_preset_model' }, { status: 400 });
  }
  if (body.params === undefined || body.system_prompt === undefined || body.provider_prefs === undefined) {
    return NextResponse.json({ error: 'full_preset_body_required' }, { status: 400 });
  }

  if (!isRecord(body.params)) {
    return NextResponse.json({ error: 'invalid_preset_params' }, { status: 400 });
  }
  const reasoningError = validateReasoningParams(body.params);
  if (reasoningError) return NextResponse.json({ error: reasoningError }, { status: 400 });

  const paramsJson = normalizePresetParams(body.params);
  const systemPrompt = typeof body.system_prompt === 'string' ? body.system_prompt : null;
  const providerPrefsResult = parseProviderPreferences(body.provider_prefs);
  if (!providerPrefsResult.ok) {
    return NextResponse.json({ error: providerPrefsResult.reason }, { status: 400 });
  }
  const providerPrefs = providerPrefsResult.value;
  if (body.enabled === false) {
    return NextResponse.json({ error: 'preset_disable_requires_disable_endpoint' }, { status: 400 });
  }
  const enabled = body.enabled === true ? true : null;

  const client = await getPool().connect();
  let updated: { id: string; version: number } | undefined;
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; version: number }>(
      `UPDATE presets
       SET version = version + 1,
           model = $3,
           params = $4,
           system_prompt = $5,
           provider_prefs = $6,
           enabled = COALESCE($7, enabled),
           updated_at = now()
       WHERE team_id = $1 AND slug = $2
       RETURNING id, version`,
      [user.teamId, slug, model, paramsJson, systemPrompt, providerPrefs, enabled],
    );
    updated = result.rows[0];
    if (!updated) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'preset_not_found' }, { status: 404 });
    }
    await client.query(
      `INSERT INTO preset_versions (id, preset_id, team_id, version, model, params, system_prompt, provider_prefs, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [`pver_${randomUUID().replace(/-/g, '')}`, updated.id, user.teamId, updated.version, model, paramsJson, systemPrompt, providerPrefs, user.userId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('presets PUT error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  } finally {
    client.release();
  }

  const cacheStatus = await bustProxyCache(user.teamId);
  return NextResponse.json({ slug, version: updated.version, ...cacheStatus });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  if (await isDemoActive()) {
    return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
  }
  const user = await requireRole('admin');
  if (!user) return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
  const adminSecretError = adminSecretErrorResponse();
  if (adminSecretError) return adminSecretError;
  const { slug } = await params;
  if (!validSlug(slug)) return NextResponse.json({ error: 'invalid_preset_slug' }, { status: 400 });
  const disable = new URL(request.url).searchParams.get('disable') === 'true';

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = disable
      ? await client.query(
        `UPDATE presets SET enabled = false, updated_at = now() WHERE team_id = $1 AND slug = $2`,
        [user.teamId, slug],
      )
      : await client.query(
        `DELETE FROM presets WHERE team_id = $1 AND slug = $2`,
        [user.teamId, slug],
      );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'preset_not_found' }, { status: 404 });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('presets DELETE error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  } finally {
    client.release();
  }

  const cacheStatus = await bustProxyCache(user.teamId);
  return NextResponse.json({ ok: true, disabled: disable, ...cacheStatus });
}
