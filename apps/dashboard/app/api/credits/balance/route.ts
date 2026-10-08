import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const teamId = (await getEffectiveTeamId(member.teamId)) as string;
    const pool = getPool();

    const { rows } = await pool.query(
      'SELECT balance_microcents, overdraft_limit_microcents FROM credit_balances WHERE team_id = $1',
      [teamId],
    );

    return NextResponse.json({
      balance_microcents: Number(rows[0]?.balance_microcents ?? 0),
      overdraft_limit_microcents: Number(rows[0]?.overdraft_limit_microcents ?? 0),
    });
  } catch (err) {
    console.error('Credits balance fetch failed:', err);
    return NextResponse.json({ error: 'Failed to fetch credit balance' }, { status: 500 });
  }
}
