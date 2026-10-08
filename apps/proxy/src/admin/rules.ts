// apps/proxy/src/admin/rules.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { invalidateRuleCache } from '../routing/rule-cache.js';
import { checkLimit } from '../billing/plan-limits.js';
import { validateQualityGateConfig } from '@routeshift/shared';

// Each supported modification key's expected shape, matching exactly what
// evaluator.ts's applyModifications() checks before applying a value. A value
// that fails its own shape check is silently ignored by the evaluator, so
// validating only key names (not shapes) let a rule persist as "active" while
// still doing nothing for that field -- reintroducing the same fail-loud gap
// this gate exists to close.
const MODIFICATION_VALIDATORS: Record<string, (value: unknown) => boolean> = {
  model_requested: (v) => typeof v === 'string' && v.length > 0,
  provider_requested: (v) => typeof v === 'string' && v.length > 0,
  add_tags: (v) => Array.isArray(v) && v.every((t) => typeof t === 'string'),
  max_output_tokens: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
};
const SUPPORTED_MODIFICATION_KEYS = new Set(Object.keys(MODIFICATION_VALIDATORS));

// The routing evaluator only enforces the documented condition keys and
// supported action shapes. It NEVER reads `condition.custom`, and only applies
// the modification keys listed above. Reject unsupported DSL at the write
// boundary so routing rules fail loud instead of being listed as active while
// production routing silently ignores them.
function unsupportedRuleFeature(condition: unknown, action: unknown): string | null {
  if (
    condition && typeof condition === 'object' &&
    Object.keys((condition as { custom?: Record<string, unknown> }).custom ?? {}).length > 0
  ) {
    return 'condition.custom is not supported by the routing evaluator';
  }
  if (action && typeof action === 'object') {
    const a = action as { type?: string; modifications?: Record<string, unknown>; quality_gate?: unknown };
    const modifications = a.modifications ?? {};
    const modificationKeys = Object.keys(modifications);
    if (a.type === 'modify') {
      if (modificationKeys.length === 0) {
        return "action.type 'modify' requires supported action.modifications";
      }
      const unsupported = modificationKeys.filter(key => !SUPPORTED_MODIFICATION_KEYS.has(key));
      if (unsupported.length > 0) {
        return `action.modifications contains unsupported key(s): ${unsupported.join(', ')}`;
      }
      const invalid = modificationKeys.filter((key) => !MODIFICATION_VALIDATORS[key](modifications[key]));
      if (invalid.length > 0) {
        return `action.modifications has invalid value(s) for: ${invalid.join(', ')}`;
      }
    } else if (modificationKeys.length > 0) {
      return "action.modifications is only supported on action.type 'modify'";
    }
    // quality_gate is valid only on a route action. Validate it strictly at this
    // write boundary so an unsupported gate fails loud instead of persisting as
    // "active" while the cascade (Phase 2) ignores or mis-handles it. The
    // evaluator never synthesizes a gate; it only passes a stored one through.
    if (a.quality_gate !== undefined) {
      if (a.type !== 'route') {
        return "action.quality_gate is only supported on action.type 'route'";
      }
      const gateResult = validateQualityGateConfig(a.quality_gate);
      if (!gateResult.ok) {
        return gateResult.error;
      }
    }
  }
  return null;
}

export async function handleCreateRule(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }
  if (!body || typeof body !== 'object') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }

  if (!body.name || !body.action) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'name and action are required' } }));
    return;
  }

  const unsupportedFeature = unsupportedRuleFeature(body.condition, body.action);
  if (unsupportedFeature) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: unsupportedFeature } }));
    return;
  }

  const teamId = body.team_id;
  // Reject the '*' wildcard here too (mirrors keys.ts handleCreateKey): otherwise
  // a global-secret caller could INSERT a global ('*') routing rule that applies
  // to every tenant. handleListRules treats '*' as the global sentinel.
  if (typeof teamId !== 'string' || teamId.length === 0 || teamId === '*') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: teamId === '*' ? 'team_id wildcard is not allowed' : 'team_id is required' },
      }),
    );
    return;
  }

  const limitCheck = await checkLimit(teamId, 'rules');
  if (!limitCheck.allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `Plan limit reached (${limitCheck.current}/${limitCheck.limit} rules). Upgrade to create more.` },
    }));
    return;
  }

  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO routing_rules (id, team_id, name, description, priority, enabled, condition, action)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, teamId, body.name, body.description ?? null,
     body.priority ?? 500, body.enabled ?? true,
     JSON.stringify(body.condition ?? {}), JSON.stringify(body.action)],
  );

  invalidateRuleCache();
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id, ...body }));
}

export async function handleListRules(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pool = getPool();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    // Reject the wildcard the same way the key + rate-limit handlers do
    // (keys.ts, team-rate-limits.ts): rules GET intentionally returns global
    // ('*') rules, so a team-scoped update/delete with team_id='*' would
    // otherwise mutate or remove GLOBAL routing rules.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: teamId === '*' ? 'team_id wildcard is not allowed' : 'team_id query parameter is required',
        },
      }),
    );
    return;
  }
  // Return team-specific rules plus global ('*') rules
  const { rows } = await pool.query(
    `SELECT id, team_id, name, description, priority, enabled, condition, action, created_at, updated_at
     FROM routing_rules
     WHERE (team_id = $1 OR team_id = '*')
     ORDER BY priority ASC`,
    [teamId],
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(rows));
}

export async function handleUpdateRule(req: IncomingMessage, res: ServerResponse, ruleId: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }
  if (!body || typeof body !== 'object') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid JSON in request body' } }));
    return;
  }

  const unsupportedFeature = unsupportedRuleFeature(body.condition, body.action);
  if (unsupportedFeature) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: unsupportedFeature } }));
    return;
  }

  const pool = getPool();
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  const allowedFields = ['name', 'priority', 'enabled', 'description'];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      setClauses.push(`${field} = $${idx++}`);
      values.push(body[field]);
    }
  }
  if (body.condition !== undefined) {
    setClauses.push(`condition = $${idx++}`);
    values.push(JSON.stringify(body.condition));
  }
  if (body.action !== undefined) {
    setClauses.push(`action = $${idx++}`);
    values.push(JSON.stringify(body.action));
  }

  if (setClauses.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'No fields to update' } }));
    return;
  }

  // Extract team_id from query parameters for team-scoped updates
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    // Reject the wildcard the same way the key + rate-limit handlers do
    // (keys.ts, team-rate-limits.ts): rules GET intentionally returns global
    // ('*') rules, so a team-scoped update/delete with team_id='*' would
    // otherwise mutate or remove GLOBAL routing rules.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: teamId === '*' ? 'team_id wildcard is not allowed' : 'team_id query parameter is required',
        },
      }),
    );
    return;
  }

  setClauses.push(`updated_at = now()`);
  values.push(ruleId);

  let whereClause = `WHERE id = $${idx}`;
  idx++;
  whereClause += ` AND team_id = $${idx}`;
  values.push(teamId);

  const { rowCount } = await pool.query(
    `UPDATE routing_rules SET ${setClauses.join(', ')} ${whereClause}`,
    values,
  );

  invalidateRuleCache();

  if (rowCount === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rule not found' } }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ updated: true }));
}

export async function handleDeleteRule(req: IncomingMessage, res: ServerResponse, ruleId: string): Promise<void> {
  // Extract team_id from query parameters for team-scoped deletion
  const url = new URL(req.url ?? '', 'http://localhost');
  const teamId = url.searchParams.get('team_id');
  if (!teamId || teamId === '*') {
    // Same wildcard guard as handleUpdateRule above: block '*' so a team-scoped
    // delete can't remove a GLOBAL ('*') routing rule.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: teamId === '*' ? 'team_id wildcard is not allowed' : 'team_id query parameter is required',
        },
      }),
    );
    return;
  }

  const pool = getPool();
  const { rowCount } = await pool.query(
    'DELETE FROM routing_rules WHERE id = $1 AND team_id = $2',
    [ruleId, teamId],
  );
  invalidateRuleCache();

  if (rowCount === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Rule not found' } }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ deleted: true }));
}
