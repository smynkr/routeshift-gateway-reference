import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';
import { ACTIVITY_LOG_SELECT, mapActivityLogRow } from '@/lib/activity-log';
import { parseActivityFilters, type ActivitySearchParams } from '@/lib/activity-filters';


const ACTIVITY_FILTER_KEYS = [
  'provider',
  'model',
  'resolved_model',
  'status',
  'category',
  'api_key_id',
  'session',
  'from',
  'to',
] as const;

export async function GET(request: Request) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const teamId = await getEffectiveTeamId(member.teamId);

    const { searchParams } = new URL(request.url);
    // Guard against NaN (e.g. ?page=abc): parseInt('abc')→NaN propagates through
    // Math.max/min and reaches SQL LIMIT/OFFSET as "NaN" → Postgres bigint error
    // → 500. Default to page 1 / limit 50 instead, matching the route's lenient
    // handling of other optional params.
    const rawPage = parseInt(searchParams.get('page') ?? '1', 10);
    const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
    const rawLimit = parseInt(searchParams.get('limit') ?? '50', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 50;
    const offset = (page - 1) * limit;

    const filterInput: ActivitySearchParams = {};
    for (const key of ACTIVITY_FILTER_KEYS) {
      const values = searchParams.getAll(key);
      if (values.length === 1) filterInput[key] = values[0];
      if (values.length > 1) filterInput[key] = values;
    }
    const filters = parseActivityFilters(filterInput);
    const hasInvalidFilter = ACTIVITY_FILTER_KEYS.some((key) => {
      const supplied = filterInput[key];
      const firstValue = Array.isArray(supplied) ? supplied[0] : supplied;
      return Boolean(firstValue?.trim()) && filters[key] === undefined;
    });
    if (hasInvalidFilter) {
      return NextResponse.json({ error: 'Invalid activity filters' }, { status: 400 });
    }
    const {
      provider,
      model,
      resolved_model: resolvedModel,
      status,
      category,
      api_key_id: apiKeyId,
      session,
      from,
      to,
    } = filters;

    const conditions: string[] = ['team_id = $1'];
    const params: any[] = [teamId];
    let paramIndex = 2;

    if (provider) {
      conditions.push(`provider = $${paramIndex}`);
      params.push(provider);
      paramIndex++;
    }

    if (model) {
      conditions.push(`(model_requested ILIKE $${paramIndex} ESCAPE '\\' OR model_resolved ILIKE $${paramIndex} ESCAPE '\\')`);
      const escapedModel = model.replace(/[%_\\]/g, '\\$&');
      params.push(`%${escapedModel}%`);
      paramIndex++;
    }

    if (resolvedModel) {
      conditions.push(`model_resolved = $${paramIndex}`);
      params.push(resolvedModel);
      paramIndex++;
    }

    if (status === 'success') {
      conditions.push('status_code < 400');
    } else if (status === 'error') {
      conditions.push('status_code >= 400');
    }

    if (category) {
      if (category === 'uncategorized') {
        conditions.push('activity_category IS NULL');
      } else {
        conditions.push(`activity_category = $${paramIndex}`);
        params.push(category);
        paramIndex++;
      }
    }

    if (apiKeyId) {
      conditions.push(`api_key_id = $${paramIndex}`);
      params.push(apiKeyId);
      paramIndex++;
    }

    if (session) {
      conditions.push(`session_id = $${paramIndex}`);
      params.push(session);
      paramIndex++;
    }

    if (from) {
      conditions.push(`timestamp >= $${paramIndex}`);
      params.push(from);
      paramIndex++;
    }

    if (to) {
      conditions.push(`timestamp <= $${paramIndex}`);
      params.push(to);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    const pool = getPool();

    const [countResult, logsResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total FROM request_logs WHERE ${whereClause}`,
        params,
      ),
      pool.query(
        `SELECT ${ACTIVITY_LOG_SELECT}
         FROM request_logs
         WHERE ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, limit, offset],
      ),
    ]);
    const total = countResult.rows[0].total;
    const logs = logsResult.rows.map((row) => mapActivityLogRow(row));

    return NextResponse.json({
      logs,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error('Logs API error:', err);
    return NextResponse.json(
      { error: 'Failed to load logs' },
      { status: 500 },
    );
  }
}
