// LAY-318: per-team model alias CRUD.
//
// GET    — list the team's aliases
// POST   — add an alias { alias, canonical_name, notes? }. Alias targets use
//          the effective dispatchable chat catalog, while every curated and
//          effective public canonical/API id is reserved from alias names.
// DELETE — remove an alias by ?alias=...
//
// Each write fires a best-effort POST to the proxy's
// /admin/model-aliases/invalidate so the proxy's 60s alias cache picks up
// the change immediately.

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { PROXY_URL, adminHeaders } from '@/lib/proxy';
import {
  CATALOG_FRESHNESS_MANIFEST,
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  EFFECTIVE_PUBLIC_MODELS,
  GOOGLE_PREVIEW_QUARANTINE_IDS,
  MODEL_REGISTRY,
} from '@routeshift/shared';

// Every model row in the generated quarantine is unavailable to alias callers,
// regardless of provider or the particular quarantine reason.
const QUARANTINED_MODEL_IDS = CATALOG_FRESHNESS_MANIFEST.quarantined
  .filter((entry) => entry.kind === 'model')
  .map((entry) => entry.model);
const RESERVED_MODEL_IDS = new Set([
  ...[...MODEL_REGISTRY, ...EFFECTIVE_PUBLIC_MODELS]
    .flatMap((model) => [model.canonical_name, model.api_model_id]),
  ...GOOGLE_PREVIEW_QUARANTINE_IDS,
  ...QUARANTINED_MODEL_IDS,
]);
const ROUTABLE_NAMES = new Set(
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS.map((model) => model.canonical_name),
);

async function bustProxyCache(teamId: string): Promise<void> {
  const res = await fetch(`${PROXY_URL}/admin/model-aliases/invalidate`, {
    method: 'POST',
    headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ team_id: teamId }),
  });
  if (!res.ok) throw new Error(`proxy model-alias invalidation failed: ${res.status}`);
}

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT alias, canonical_name, notes, updated_at
       FROM model_aliases
       WHERE team_id = $1
       ORDER BY alias ASC`,
      [teamId],
    );
    return NextResponse.json({
      aliases: rows.map((r) => ({
        alias: r.alias as string,
        canonical_name: r.canonical_name as string,
        notes: (r.notes as string | null) ?? null,
        updated_at: r.updated_at as Date,
      })),
    });
  } catch (err) {
    console.error('model-aliases GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
    const teamId = user.teamId;

    const body = (await request.json()) as { alias?: unknown; canonical_name?: unknown; notes?: unknown };
    const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
    const canonicalName = typeof body.canonical_name === 'string' ? body.canonical_name.trim() : '';
    const notes = typeof body.notes === 'string' ? body.notes.trim() : null;

    if (!alias || alias.length > 200) {
      return NextResponse.json({ error: 'alias must be 1–200 characters' }, { status: 400 });
    }
    if (!canonicalName) {
      return NextResponse.json({ error: 'canonical_name is required' }, { status: 400 });
    }
    if (alias === canonicalName) {
      return NextResponse.json({ error: 'alias cannot equal canonical_name (no-op)' }, { status: 400 });
    }
    if (RESERVED_MODEL_IDS.has(alias)) {
      return NextResponse.json(
        { error: `alias "${alias}" collides with an effective model id and would be unreachable` },
        { status: 400 },
      );
    }
    if (!ROUTABLE_NAMES.has(canonicalName)) {
      return NextResponse.json(
        { error: `canonical_name "${canonicalName}" is not an effective dispatchable chat model` },
        { status: 400 },
      );
    }

    const pool = getPool();
    await pool.query(
      `INSERT INTO model_aliases (team_id, alias, canonical_name, notes)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, alias) DO UPDATE SET
         canonical_name = EXCLUDED.canonical_name,
         notes = EXCLUDED.notes,
         updated_at = now()`,
      [teamId, alias, canonicalName, notes],
    );

    try {
      await bustProxyCache(teamId);
    } catch (err) {
      console.error('model-aliases proxy cache invalidation failed:', err);
      return NextResponse.json({
        ok: true,
        alias,
        canonical_name: canonicalName,
        notes,
        proxy_cache_invalidated: false,
        proxy_cache_error: 'proxy_cache_invalidation_failed',
        cache_ttl_seconds: 60,
      });
    }
    return NextResponse.json({
      ok: true,
      alias,
      canonical_name: canonicalName,
      notes,
      proxy_cache_invalidated: true,
    });
  } catch (err) {
    console.error('model-aliases POST error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const user = await requireRole('admin');
    if (!user) return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
    const teamId = user.teamId;

    const { searchParams } = new URL(request.url);
    const alias = searchParams.get('alias');
    if (!alias) return NextResponse.json({ error: 'alias query param required' }, { status: 400 });

    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM model_aliases WHERE team_id = $1 AND alias = $2`,
      [teamId, alias],
    );
    if (result.rowCount === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    try {
      await bustProxyCache(teamId);
    } catch (err) {
      console.error('model-aliases proxy cache invalidation failed:', err);
      return NextResponse.json({
        ok: true,
        proxy_cache_invalidated: false,
        proxy_cache_error: 'proxy_cache_invalidation_failed',
        cache_ttl_seconds: 60,
      });
    }
    return NextResponse.json({ ok: true, proxy_cache_invalidated: true });
  } catch (err) {
    console.error('model-aliases DELETE error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
