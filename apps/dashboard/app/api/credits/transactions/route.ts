import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const teamId = (await getEffectiveTeamId(member.teamId)) as string;
    const pool = getPool();

    const { searchParams } = new URL(request.url);
    // Guard against NaN (e.g. ?page=abc): NaN would propagate into SQL
    // LIMIT/OFFSET as "NaN" → Postgres bigint error → 500. Default instead.
    const rawPage = parseInt(searchParams.get('page') ?? '1', 10);
    const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
    const rawLimit = parseInt(searchParams.get('limit') ?? '20', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
    const type = searchParams.get('type');
    const offset = (page - 1) * limit;

    const VALID_TYPES = ['purchase', 'deduction', 'auto_topup'];
    if (type && !VALID_TYPES.includes(type)) {
      return NextResponse.json({ error: 'Invalid type filter' }, { status: 400 });
    }

    let countQuery = 'SELECT COUNT(*)::int AS total FROM credit_transactions WHERE team_id = $1';
    let dataQuery = `SELECT id, amount_microcents, type, reference_id, description, balance_after_microcents, created_at
       FROM credit_transactions WHERE team_id = $1`;
    const params: any[] = [teamId];

    if (type) {
      countQuery += ' AND type = $2';
      dataQuery += ' AND type = $2';
      params.push(type);
    }

    dataQuery += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    const [{ rows: countRows }, { rows: transactions }] = await Promise.all([
      pool.query(countQuery, params),
      pool.query(dataQuery, [...params, limit, offset]),
    ]);

    const total = countRows[0].total;

    // amount_microcents / balance_after_microcents are BIGINT columns, which the
    // pg driver returns as strings to avoid precision loss. The client
    // (components/credits/transaction-history.tsx) types them as `number` and
    // does arithmetic/formatting on them, so normalize here. Values stay well
    // under Number.MAX_SAFE_INTEGER (e.g. $1M == 1e14 microcents).
    const normalized = transactions.map((tx) => ({
      ...tx,
      amount_microcents: Number(tx.amount_microcents),
      balance_after_microcents: Number(tx.balance_after_microcents),
    }));

    return NextResponse.json({
      transactions: normalized,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      limit,
    });
  } catch (err) {
    console.error('Credits transactions fetch failed:', err);
    return NextResponse.json({ error: 'Failed to fetch credit transactions' }, { status: 500 });
  }
}
