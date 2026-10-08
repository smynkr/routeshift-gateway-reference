// LAY-347: GET /api/keys/audit — proxy thin-wrapper around the team-wide
// /admin/keys/audit endpoint. Used by the workspace audit page.

import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireTeamMembership } from '@/lib/rbac';
import { isDemoActive } from '@/lib/demo';
import { DEMO_TEAM_ID } from '@/lib/demo-constants';
import { getPool } from '@/lib/db';

const FORWARDED_PARAMS = [
  'event_type',
  'actor',
  'key_prefix',
  'from',
  'to',
  'limit',
  'cursor',
] as const;

const AUDIT_MAX_LIMIT = 200;

/**
 * Demo-mode read: query the seeded api_key_audit_events table directly,
 * mirroring the proxy's GET /admin/keys/audit response shape
 * ({ events: [...], next_cursor }) including the base64url (created_at, id)
 * cursor pagination and the same filters the proxy honours.
 */
async function demoAudit(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const params: unknown[] = [DEMO_TEAM_ID];
  const where: string[] = ['team_id = $1'];

  const eventType = url.searchParams.get('event_type');
  if (eventType) {
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
    params.push(`${keyPrefix}%`);
    where.push(`key_prefix LIKE $${params.length}`);
  }
  const from = url.searchParams.get('from');
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}`);
  }
  const to = url.searchParams.get('to');
  if (to) {
    params.push(to);
    where.push(`created_at < $${params.length}`);
  }

  const cursorRaw = url.searchParams.get('cursor');
  if (cursorRaw) {
    try {
      const decoded = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
      // Validate the shapes BEFORE they reach ::timestamptz/::uuid casts — a
      // syntactically valid string that isn't a real date/uuid would make
      // Postgres throw (500) instead of being treated as a malformed cursor.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        typeof decoded?.created_at === 'string'
        && typeof decoded?.id === 'string'
        && !Number.isNaN(Date.parse(decoded.created_at))
        && UUID_RE.test(decoded.id)
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

  const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, AUDIT_MAX_LIMIT) : 50;
  params.push(limit + 1);

  const sql = `
    SELECT id, api_key_id, key_prefix, event_type, actor_user_id, details, created_at
      FROM api_key_audit_events
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}
  `;

  const { rows } = await getPool().query(sql, params);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            created_at:
              last.created_at instanceof Date
                ? last.created_at.toISOString()
                : String(last.created_at),
            id: last.id,
          }),
          'utf8',
        ).toString('base64url')
      : null;

  return NextResponse.json({ events: page, next_cursor: nextCursor });
}

export async function GET(request: Request) {
  try {
    if (await isDemoActive()) {
      return await demoAudit(request);
    }

    // Re-validate team membership against team_members rather than trusting the
    // (30-day) JWT's teamId — a removed member must not keep reading the audit feed.
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    assertAdminSecret();
    const teamId = member.teamId;

    const url = new URL(request.url);
    const upstream = new URL(`${PROXY_URL}/admin/keys/audit`);
    upstream.searchParams.set('team_id', teamId);
    for (const name of FORWARDED_PARAMS) {
      const value = url.searchParams.get(name);
      if (value !== null && value !== '') upstream.searchParams.set(name, value);
    }

    const res = await fetch(upstream, { headers: adminHeaders(), cache: 'no-store' });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch (err) {
    console.error('Failed to fetch team audit events from proxy:', err);
    return NextResponse.json({ error: { message: 'Proxy unavailable' } }, { status: 502 });
  }
}
