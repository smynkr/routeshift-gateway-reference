import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireTeamMembership } from '@/lib/rbac';
import { denyAuthorization } from '@/lib/oauth-device-service';
import { isSameOriginRequest, parseOAuthBody } from '@/lib/oauth-http';

// POST /api/oauth/device/deny
// Session-gated. The signed-in user rejects a pending device authorization;
// the device's next token poll then receives access_denied.
export async function POST(request: Request) {
  // CSRF: cookie-authenticated, state-changing — reject cross-site callers.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  }

  const member = await requireTeamMembership();
  if (!member) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await parseOAuthBody(request);
  const userCode = body.user_code?.trim();
  if (!userCode) {
    return NextResponse.json({ error: 'user_code is required' }, { status: 400 });
  }

  try {
    const pool = getPool();
    const result = await denyAuthorization(pool, userCode);
    switch (result) {
      case 'denied':
        return NextResponse.json({ status: 'denied' });
      case 'not_found':
        return NextResponse.json({ error: 'invalid_user_code' }, { status: 404 });
      case 'already_resolved':
        return NextResponse.json({ error: 'already_resolved' }, { status: 409 });
    }
  } catch (err) {
    console.error('oauth/device/deny failed:', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
