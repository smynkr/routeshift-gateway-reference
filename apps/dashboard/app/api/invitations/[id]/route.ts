import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/rbac';
import { getPool } from '@/lib/db';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

// DELETE — cancel a pending invitation (owner only)
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const caller = await requireRole('owner');
    if (!caller) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { id } = await params;
    const pool = getPool();

    const { rowCount } = await pool.query(
      `DELETE FROM team_invitations WHERE id = $1 AND team_id = $2 AND status = 'pending'`,
      [id, caller.teamId],
    );

    if (rowCount === 0) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Cancel invitation error:', err);
    return NextResponse.json({ error: 'Failed to cancel invitation' }, { status: 500 });
  }
}
