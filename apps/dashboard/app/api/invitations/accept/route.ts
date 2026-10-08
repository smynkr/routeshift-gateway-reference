import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getPool } from '@/lib/db';

// POST — accept an invitation (logged-in user, matching email)
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { token } = await request.json();
    if (!token) {
      return NextResponse.json({ error: 'Token is required' }, { status: 400 });
    }

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock the invitation row for the duration of this transaction so
      // concurrent accepts serialize. Previously the precheck was outside
      // the txn — two tabs both passed prechecks, then the second hit a
      // PK violation on team_members and returned a generic 500.
      const { rows } = await client.query(
        `SELECT id, team_id, email, role, expires_at, status
           FROM team_invitations
          WHERE token = $1
          FOR UPDATE`,
        [token],
      );

      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Invalid or expired invitation' }, { status: 404 });
      }

      const invitation = rows[0];

      // Check status — if already accepted by a concurrent request, return 404
      if (invitation.status !== 'pending') {
        await client.query('ROLLBACK');
        return NextResponse.json({ error: 'Invalid or expired invitation' }, { status: 404 });
      }

      // Check expiry
      if (new Date(invitation.expires_at) < new Date()) {
        await client.query(
          `UPDATE team_invitations SET status = 'expired' WHERE id = $1`,
          [invitation.id],
        );
        await client.query('COMMIT');
        return NextResponse.json({ error: 'Invalid or expired invitation' }, { status: 404 });
      }

      // Check email matches — use same generic error to prevent enumeration
      if (session.user.email?.toLowerCase() !== invitation.email.toLowerCase()) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: 'Invalid or expired invitation' },
          { status: 404 },
        );
      }

      // Check if already a member (idempotent: return 409, not 500)
      const { rows: existing } = await client.query(
        `SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2`,
        [session.user.id, invitation.team_id],
      );
      if (existing.length > 0) {
        await client.query(
          `UPDATE team_invitations SET status = 'accepted' WHERE id = $1`,
          [invitation.id],
        );
        await client.query('COMMIT');
        return NextResponse.json({ error: 'Already a member of this team' }, { status: 409 });
      }

      // Accept: add to team, update invitation status
      await client.query(
        `INSERT INTO team_members (user_id, team_id, role) VALUES ($1, $2, $3)`,
        [session.user.id, invitation.team_id, invitation.role],
      );
      await client.query(
        `UPDATE team_invitations SET status = 'accepted' WHERE id = $1`,
        [invitation.id],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Accept invitation error:', err);
    return NextResponse.json({ error: 'Failed to accept invitation' }, { status: 500 });
  }
}
