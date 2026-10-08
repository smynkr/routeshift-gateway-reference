// LAY-326: label-scoped operations on a single provider key.
//
// PATCH allows partial updates: weight, enabled, key (rotate), metadata.
// DELETE removes one labeled key — distinct from the bucket-wide DELETE
// at /api/provider-keys/[provider] which clears the whole provider.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/rbac';
import { getPool } from '@/lib/db';
import { isValidProvider, VALID_PROVIDERS, validateProviderMetadata } from '@/lib/provider-metadata';
import { encryptProviderKey } from '@/lib/crypto';
import { classifyDashboardWritableEnvelope } from '@/lib/provider-key-write-envelope';
import { PROXY_URL, adminHeaders } from '@/lib/proxy';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

async function invalidateProxyCache(teamId: string, provider: string): Promise<void> {
  const res = await fetch(`${PROXY_URL}/admin/provider-keys/invalidate`, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ team_id: teamId, provider }),
  });
  if (!res.ok) throw new Error(`proxy provider-key invalidation failed: ${res.status}`);
}

function providerCacheLagResponse(provider: string, label: string) {
  return NextResponse.json({
    success: true,
    provider,
    label,
    proxy_cache_invalidated: false,
    proxy_cache_error: 'proxy_cache_invalidation_failed',
    cache_ttl_seconds: 300,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ provider: string; label: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { provider, label } = await params;
    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: { message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` } },
        { status: 400 },
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if ('weight' in body) {
      const w = body.weight;
      if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 1000) {
        return NextResponse.json(
          { error: { message: 'weight must be an integer between 1 and 1000' } },
          { status: 400 },
        );
      }
      push('weight', w);
    }
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') {
        return NextResponse.json(
          { error: { message: 'enabled must be a boolean' } },
          { status: 400 },
        );
      }
      push('enabled', body.enabled);
    }
    if ('key' in body) {
      const normalizedKey = typeof body.key === 'string' ? body.key.trim() : '';
      if (!normalizedKey) {
        return NextResponse.json(
          { error: { message: 'key must be a non-empty string' } },
          { status: 400 },
        );
      }
      const encrypted = await encryptProviderKey(normalizedKey);
      const scheme = classifyDashboardWritableEnvelope(encrypted);
      push('encrypted_key', encrypted);
      push('encryption_scheme', scheme);
      push('encryption_key_version', null);
    }
    if ('metadata' in body) {
      const md = body.metadata;
      if (md === null || typeof md !== 'object' || Array.isArray(md)) {
        return NextResponse.json(
          { error: { message: 'metadata must be a JSON object' } },
          { status: 400 },
        );
      }
      const metadataError = validateProviderMetadata(provider, md as Record<string, unknown>);
      if (metadataError) {
        return NextResponse.json({ error: { message: metadataError } }, { status: 400 });
      }
      push('metadata', md);
    }

    if (sets.length === 0) {
      return NextResponse.json(
        { error: { message: 'No updatable fields provided' } },
        { status: 400 },
      );
    }

    sets.push('updated_at = now()');
    values.push(user.teamId, provider, label);

    const pool = getPool();
    const { rowCount } = await pool.query(
      `UPDATE provider_keys
         SET ${sets.join(', ')}
       WHERE team_id = $${values.length - 2}
         AND provider = $${values.length - 1}
         AND label = $${values.length}`,
      values,
    );

    if (rowCount === 0) {
      return NextResponse.json(
        { error: { message: `No provider key found for ${provider}/${label}` } },
        { status: 404 },
      );
    }

    try {
      await invalidateProxyCache(user.teamId, provider);
    } catch (err) {
      console.error('Provider key cache invalidation failed:', err);
      return providerCacheLagResponse(provider, label);
    }
    return NextResponse.json({ success: true, provider, label, proxy_cache_invalidated: true });
  } catch (err) {
    console.error('Failed to patch provider key:', err);
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ provider: string; label: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: { message: DEMO_WRITE_BLOCKED_MESSAGE } }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { provider, label } = await params;
    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: { message: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` } },
        { status: 400 },
      );
    }

    const pool = getPool();
    const { rowCount } = await pool.query(
      `DELETE FROM provider_keys
        WHERE team_id = $1 AND provider = $2 AND label = $3`,
      [user.teamId, provider, label],
    );

    if (rowCount === 0) {
      return NextResponse.json(
        { error: { message: `No provider key found for ${provider}/${label}` } },
        { status: 404 },
      );
    }

    try {
      await invalidateProxyCache(user.teamId, provider);
    } catch (err) {
      console.error('Provider key cache invalidation failed:', err);
      return providerCacheLagResponse(provider, label);
    }
    return NextResponse.json({ success: true, provider, label, proxy_cache_invalidated: true });
  } catch (err) {
    console.error('Failed to delete provider key:', err);
    return NextResponse.json({ error: { message: 'Internal server error' } }, { status: 500 });
  }
}
