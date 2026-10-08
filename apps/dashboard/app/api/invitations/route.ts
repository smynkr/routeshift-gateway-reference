import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/rbac';
import { getPool } from '@/lib/db';
import { getRequiredAppOrigin } from '@/lib/app-origin';
import { randomUUID } from 'crypto';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

// GET — list pending invitations for the team (owner/admin only)
export async function GET() {
  try {
    const caller = await requireRole('admin');
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const teamId = caller.teamId;

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT i.id, i.email, i.role, i.status, i.created_at, i.expires_at, u.name AS invited_by_name
       FROM team_invitations i
       JOIN users u ON u.id = i.invited_by
       WHERE i.team_id = $1 AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [teamId],
    );

    return NextResponse.json(rows);
  } catch (err) {
    console.error('List invitations error:', err);
    return NextResponse.json({ error: 'Failed to list invitations' }, { status: 500 });
  }
}

// POST — create a new invitation (owner only)
export async function POST(request: Request) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const caller = await requireRole('owner');
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { email, role = 'member' } = body;

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
    }

    if (!['member', 'admin'].includes(role)) {
      return NextResponse.json({ error: 'Role must be member or admin' }, { status: 400 });
    }

    // Normalize once so the dedup checks below compare against the SAME value we
    // persist (lowercased). Previously the checks used the raw mixed-case input
    // while the INSERT stored email.toLowerCase(), so `Foo@x.com` slipped past
    // the already-member / already-pending guards for `foo@x.com`.
    const normalizedEmail = email.trim().toLowerCase();

    const pool = getPool();

    // Check if user is already a member (case-insensitive on stored email too)
    const { rows: existing } = await pool.query(
      `SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 AND LOWER(u.email) = $2`,
      [caller.teamId, normalizedEmail],
    );
    if (existing.length > 0) {
      return NextResponse.json({ error: 'User is already a team member' }, { status: 409 });
    }

    // Check for existing pending invitation
    const { rows: pendingInv } = await pool.query(
      `SELECT 1 FROM team_invitations WHERE team_id = $1 AND email = $2 AND status = 'pending'`,
      [caller.teamId, normalizedEmail],
    );
    if (pendingInv.length > 0) {
      return NextResponse.json({ error: 'Invitation already pending for this email' }, { status: 409 });
    }

    const id = `inv_${randomUUID().replace(/-/g, '')}`;
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO team_invitations (id, team_id, email, role, invited_by, token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, caller.teamId, normalizedEmail, role, caller.userId, token, expiresAt],
    );

    const inviteUrl = `${getRequiredAppOrigin('invitation URLs')}/invite/${token}`;

    return NextResponse.json({ id, inviteUrl, email: normalizedEmail, role, expires_at: expiresAt });
  } catch (err) {
    console.error('Create invitation error:', err);
    return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
  }
}
