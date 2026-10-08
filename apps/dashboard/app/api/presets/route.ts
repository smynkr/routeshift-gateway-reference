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
  slug?: unknown;
  model?: unknown;
  params?: unknown;
  system_prompt?: unknown;
  provider_prefs?: unknown;
  enabled?: unknown;
}

function presetId(prefix: 'preset' | 'pver'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSlug(slug: string): string | null {
  return SLUG_RE.test(slug) ? null : 'invalid_preset_slug';
}

function validateModel(model: string): string | null {
  if (CANONICAL_NAMES.has(model)) return null;
  const parsed = parseModelSuffixes(model);
  return parsed.ok && CANONICAL_NAMES.has(parsed.model) ? null : 'invalid_preset_model';
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

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;

    const { rows } = await getPool().query(
      `SELECT slug, version, model, params, system_prompt, provider_prefs, enabled, updated_at
       FROM presets
       WHERE team_id = $1
       ORDER BY slug ASC`,
      [teamId],
    );
    return NextResponse.json({ presets: rows });
  } catch (err) {
    console.error('presets GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  // Demo mode is read-only — block preset writes like rule writes do, so a demo
  // session can't mutate the real workspace's presets.
  if (await isDemoActive()) {
    return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
  }
  const user = await requireRole('admin');
  if (!user) return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
  const adminSecretError = adminSecretErrorResponse();
  if (adminSecretError) return adminSecretError;

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

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const slugError = validateSlug(slug);
  if (slugError) return NextResponse.json({ error: slugError }, { status: 400 });
  const modelError = validateModel(model);
  if (modelError) return NextResponse.json({ error: modelError }, { status: 400 });

  if (body.params !== undefined && !isRecord(body.params)) {
    return NextResponse.json({ error: 'invalid_preset_params' }, { status: 400 });
  }
  if (body.params !== undefined) {
    const reasoningError = validateReasoningParams(body.params);
    if (reasoningError) return NextResponse.json({ error: reasoningError }, { status: 400 });
  }

  const params = normalizePresetParams(body.params);
  const systemPrompt = typeof body.system_prompt === 'string' ? body.system_prompt : null;
  const providerPrefsResult = parseProviderPreferences(body.provider_prefs);
  if (!providerPrefsResult.ok) {
    return NextResponse.json({ error: providerPrefsResult.reason }, { status: 400 });
  }
  const providerPrefs = providerPrefsResult.value;
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;

  const pool = getPool();
  const client = await pool.connect();
  const preset_id = presetId('preset');
  const version_id = presetId('pver');
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO presets (id, team_id, slug, version, model, params, system_prompt, provider_prefs, enabled, created_by)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)`,
      [preset_id, user.teamId, slug, model, params, systemPrompt, providerPrefs, enabled, user.userId],
    );
    await client.query(
      `INSERT INTO preset_versions (id, preset_id, team_id, version, model, params, system_prompt, provider_prefs, created_by)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
      [version_id, preset_id, user.teamId, model, params, systemPrompt, providerPrefs, user.userId],
    );
    await client.query('COMMIT');
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    if ((err as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'preset_slug_taken' }, { status: 409 });
    }
    console.error('presets POST error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  } finally {
    client.release();
  }

  const cacheStatus = await bustProxyCache(user.teamId);
  return NextResponse.json({ id: preset_id, slug, version: 1, ...cacheStatus }, { status: 201 });
}
