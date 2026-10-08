import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireRole } from '@/lib/rbac';
import { getPool } from '@/lib/db';
import { encryptProviderKey } from '@/lib/crypto';
import { classifyDashboardWritableEnvelope } from '@/lib/provider-key-write-envelope';
import { PROXY_URL, adminHeaders } from '@/lib/proxy';
import { isValidProvider, VALID_PROVIDERS, validateProviderMetadata } from '@/lib/provider-metadata';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';
import { readJsonObject } from '@/lib/request-json';

async function invalidateProxyCache(teamId: string, provider: string): Promise<void> {
  const res = await fetch(`${PROXY_URL}/admin/provider-keys/invalidate`, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ team_id: teamId, provider }),
  });
  if (!res.ok) throw new Error(`proxy provider-key invalidation failed: ${res.status}`);
}

function providerCacheLagResponse(payload: Record<string, unknown>) {
  return NextResponse.json({
    success: true,
    ...payload,
    proxy_cache_invalidated: false,
    proxy_cache_error: 'proxy_cache_invalidation_failed',
    cache_ttl_seconds: 300,
  });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { provider } = await params;
    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: { message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` } },
        { status: 400 },
      );
    }

    const body = await readJsonObject(request);
    if (!body) {
      return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
    }
    const { key, metadata } = body;
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    if (!normalizedKey) {
      return NextResponse.json({ error: { message: 'Missing or invalid key' } }, { status: 400 });
    }
    const safeMetadata =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};

    const metadataError = validateProviderMetadata(provider, safeMetadata as Record<string, unknown>);
    if (metadataError) {
      return NextResponse.json(
        { error: { message: metadataError } },
        { status: 400 },
      );
    }

    const encrypted = await encryptProviderKey(normalizedKey);
    const scheme = classifyDashboardWritableEnvelope(encrypted);
    const id = `pk_${randomUUID().replace(/-/g, '')}`;
    const pool = getPool();

    // LAY-319: writes use the implicit 'default' label so the single-key
    // flow keeps working. The N-key settings UX (adding labeled keys) is
    // tracked separately.
    await pool.query(
      `INSERT INTO provider_keys (id, team_id, provider, encrypted_key, metadata, label, weight, enabled, encryption_scheme, encryption_key_version)
       VALUES ($1, $2, $3, $4, $5, 'default', 1, true, $6, NULL)
       ON CONFLICT (team_id, provider, label) DO UPDATE
         SET encrypted_key = EXCLUDED.encrypted_key,
             metadata = EXCLUDED.metadata,
             encryption_scheme = EXCLUDED.encryption_scheme,
             encryption_key_version = NULL,
             enabled = true,
             updated_at = now()`,
      [id, user.teamId, provider, encrypted, safeMetadata, scheme],
    );

    try {
      await invalidateProxyCache(user.teamId, provider);
    } catch (err) {
      console.error('Provider key cache invalidation failed:', err);
      return providerCacheLagResponse({ provider });
    }

    return NextResponse.json({ success: true, provider, proxy_cache_invalidated: true });
  } catch (err) {
    console.error('Failed to save provider key:', err);
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}

// LAY-326: POST adds a labeled key alongside the existing default. Body:
// { label, key, weight?, enabled?, metadata? }. Reject duplicate
// (team, provider, label) so adds are idempotent — call PATCH on the
// label-scoped route to update an existing labeled key.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { provider } = await params;
    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: { message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` } },
        { status: 400 },
      );
    }

    const body = await readJsonObject(request);
    if (!body) {
      return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
    }
    const { label, key, weight, enabled, metadata } = body;

    if (typeof label !== 'string' || label.length === 0 || label.length > 64) {
      return NextResponse.json(
        { error: { message: 'label must be a string between 1 and 64 characters' } },
        { status: 400 },
      );
    }
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    if (!normalizedKey) {
      return NextResponse.json({ error: { message: 'Missing or invalid key' } }, { status: 400 });
    }
    const safeWeight =
      typeof weight === 'number' && Number.isInteger(weight) && weight >= 1 && weight <= 1000
        ? weight
        : 1;
    const safeEnabled = typeof enabled === 'boolean' ? enabled : true;
    const safeMetadata =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};

    const metadataError = validateProviderMetadata(provider, safeMetadata as Record<string, unknown>);
    if (metadataError) {
      return NextResponse.json(
        { error: { message: metadataError } },
        { status: 400 },
      );
    }

    const encrypted = await encryptProviderKey(normalizedKey);
    const scheme = classifyDashboardWritableEnvelope(encrypted);
    const id = `pk_${randomUUID().replace(/-/g, '')}`;
    const pool = getPool();

    try {
      await pool.query(
        `INSERT INTO provider_keys
           (id, team_id, provider, encrypted_key, metadata, label, weight, enabled, encryption_scheme, encryption_key_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)`,
        [id, user.teamId, provider, encrypted, safeMetadata, label, safeWeight, safeEnabled, scheme],
      );
    } catch (err: unknown) {
      // 23505 = unique_violation on (team_id, provider, label).
      if ((err as { code?: string })?.code === '23505') {
        return NextResponse.json(
          { error: { message: `A key with label '${label}' already exists for ${provider}. Use PATCH to update it.` } },
          { status: 409 },
        );
      }
      throw err;
    }

    try {
      await invalidateProxyCache(user.teamId, provider);
    } catch (err) {
      console.error('Provider key cache invalidation failed:', err);
      return providerCacheLagResponse({ provider, label });
    }

    return NextResponse.json({ success: true, provider, label, proxy_cache_invalidated: true });
  } catch (err) {
    console.error('Failed to add labeled provider key:', err);
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { provider } = await params;
    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: { message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` } },
        { status: 400 },
      );
    }

    const pool = getPool();
    // LAY-319: delete every key for this (team, provider). When the multi-
    // key UX ships we'll switch to a label-scoped delete; for now the
    // single-key flow expects the whole bucket cleared.
    await pool.query(
      'DELETE FROM provider_keys WHERE team_id = $1 AND provider = $2',
      [user.teamId, provider],
    );

    try {
      await invalidateProxyCache(user.teamId, provider);
    } catch (err) {
      console.error('Provider key cache invalidation failed:', err);
      return providerCacheLagResponse({ provider });
    }

    return NextResponse.json({ success: true, provider, proxy_cache_invalidated: true });
  } catch (err) {
    console.error('Failed to delete provider key:', err);
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}
