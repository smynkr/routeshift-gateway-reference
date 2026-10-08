import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireTeamMembership } from '@/lib/rbac';
import { approveAuthorization } from '@/lib/oauth-device-service';
import { isEmailDomainAllowed } from '@/lib/email-allowlist';
import { isSameOriginRequest, parseOAuthBody } from '@/lib/oauth-http';

// POST /api/oauth/device/approve
// Session-gated. The signed-in user approves a pending device authorization,
// which attaches their identity and team to it. Self-provisioning is gated by
// the org email-domain allowlist: a user whose email domain isn't allowlisted
// for their team CANNOT approve — this is the bypass-proof governance check.
// Minting is deferred to the token poll, so no secret is created here.
export async function POST(request: Request) {
  // CSRF: this is a cookie-authenticated, state-changing action invoked only by
  // the first-party /device page. Reject cross-site requests before doing anything.
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

    // Resolve the canonical email from the DB rather than trusting the JWT.
    const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [member.userId]);
    const email = rows[0]?.email as string | undefined;
    if (!email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Governance gate. Fail closed: unknown/unlisted domain → forbidden.
    const allowed = await isEmailDomainAllowed(pool, member.teamId, email);
    if (!allowed) {
      return NextResponse.json(
        {
          error: 'self_provisioning_forbidden',
          error_description:
            'Your email domain is not allowlisted for self-service key provisioning on this team. Ask an admin to add it.',
        },
        { status: 403 },
      );
    }

    const result = await approveAuthorization(pool, {
      userCodeInput: userCode,
      teamId: member.teamId,
      userId: member.userId,
      userEmail: email,
    });

    switch (result) {
      case 'approved':
        return NextResponse.json({ status: 'approved' });
      case 'not_found':
        return NextResponse.json({ error: 'invalid_user_code' }, { status: 404 });
      case 'expired':
        return NextResponse.json({ error: 'expired_token' }, { status: 410 });
      case 'already_resolved':
        return NextResponse.json({ error: 'already_resolved' }, { status: 409 });
    }
  } catch (err) {
    console.error('oauth/device/approve failed:', err);
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
