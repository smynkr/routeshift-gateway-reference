import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/rbac';
import { getPool } from '@/lib/db';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

// PATCH — change a member's role (owner only)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const caller = await requireRole('owner');
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { userId } = await params;
    const { role } = await request.json();

    if (!['member', 'admin'].includes(role)) {
      return NextResponse.json({ error: 'Role must be member or admin' }, { status: 400 });
    }

    // Can't change own role
    if (userId === caller.userId) {
      return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 });
    }

    const pool = getPool();

    // Can't change another owner's role
    const { rows: targetMember } = await pool.query(
      `SELECT role FROM team_members WHERE user_id = $1 AND team_id = $2`,
      [userId, caller.teamId],
    );
    if (targetMember.length === 0) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    if (targetMember[0].role === 'owner') {
      return NextResponse.json({ error: 'Cannot change an owner\'s role' }, { status: 400 });
    }

    await pool.query(
      `UPDATE team_members SET role = $1 WHERE user_id = $2 AND team_id = $3`,
      [role, userId, caller.teamId],
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Update member role error:', err);
    return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
  }
}

// DELETE — remove a member from the team (owner only)
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const caller = await requireRole('owner');
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { userId } = await params;

    // Can't remove yourself
    if (userId === caller.userId) {
      return NextResponse.json({ error: 'Cannot remove yourself from the team' }, { status: 400 });
    }

    const pool = getPool();

    // Can't remove another owner
    const { rows: targetMember } = await pool.query(
      `SELECT role FROM team_members WHERE user_id = $1 AND team_id = $2`,
      [userId, caller.teamId],
    );
    if (targetMember.length === 0) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }
    if (targetMember[0].role === 'owner') {
      return NextResponse.json({ error: 'Cannot remove another owner' }, { status: 400 });
    }

    await pool.query(
      `DELETE FROM team_members WHERE user_id = $1 AND team_id = $2`,
      [userId, caller.teamId],
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 });
  }
}
