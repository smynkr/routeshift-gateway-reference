/**
 * RSH-85 Phase 1 — shadow experiment admin API (disabled by default).
 *
 * CRUD for team-scoped shadow experiments. Every handler is gated on
 * SHADOW_ROUTING_ENABLED=true; without it, all routes return 404.
 * Every query is team-scoped; wildcard tenants are rejected.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/pool.js';

const MAX_JSON_BODY_BYTES = 64 * 1024;

class JsonBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'JsonBodyTooLargeError';
  }
}

function isEnabled(): boolean {
  return process.env.SHADOW_ROUTING_ENABLED === 'true';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function error(res: ServerResponse, status: number, message: string, code: string): void {
  json(res, status, { error: { message, code } });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_JSON_BODY_BYTES) {
      req.resume();
      throw new JsonBodyTooLargeError();
    }
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON body must be an object');
  }
  return parsed as Record<string, unknown>;
}

const REQUIRED_CREATE_FIELDS = [
  'name', 'source_provider', 'source_model',
  'candidate_provider', 'candidate_model',
  'sample_rate_ppm', 'sampling_version',
  'shadow_sampling_key_version', 'verifier_version', 'gate_fingerprint',
  'max_samples', 'deadline_ms', 'max_concurrency', 'max_queue_count',
  'max_queue_bytes', 'max_payload_bytes', 'per_run_cap_microcents',
  'aggregate_cap_microcents',
] as const;

const EXECUTION_BOUND_FIELDS = [
  'max_samples', 'deadline_ms', 'max_concurrency', 'max_queue_count',
  'max_queue_bytes', 'max_payload_bytes', 'per_run_cap_microcents',
  'aggregate_cap_microcents',
] as const;

const POSITIVE_EXECUTION_BOUND_FIELDS = [
  'deadline_ms', 'max_concurrency', 'max_payload_bytes',
] as const;

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_INTEGER_BOUND_FIELDS = [
  'max_samples', 'deadline_ms', 'max_concurrency', 'max_queue_count',
  'max_queue_bytes', 'max_payload_bytes',
] as const;

const OPTIONAL_TIMESTAMP_FIELDS = ['starts_at', 'ends_at', 'kill_switch_at'] as const;

const REQUIRED_TEXT_FIELDS = [
  'name', 'source_provider', 'source_model', 'candidate_provider', 'candidate_model',
  'sampling_version', 'shadow_sampling_key_version', 'verifier_version', 'gate_fingerprint',
] as const;

const POST_ALLOWED_FIELDS = new Set<string>([
  ...REQUIRED_CREATE_FIELDS,
  'team_id', 'starts_at', 'ends_at', 'funding_mode', 'created_by',
]);

function isOptionalTimestamp(value: unknown): boolean {
  if (value === undefined || value === null || typeof value !== 'string') return value === undefined || value === null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '00', zone] = match;
  const numbers = [year, month, day, hour, minute, second].map(Number);
  const [y, mo, d, h, mi, s] = numbers;
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  const calendar = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 || calendar.getUTCDate() !== d) return false;
  if (zone !== 'Z') {
    const offset = /^[-+](\d{2}):?(\d{2})$/.exec(zone);
    if (!offset || Number(offset[1]) > 15 || Number(offset[2]) > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** GET /admin/shadow-experiments — list team's experiments. */
export async function handleShadowExperiments(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  if (!isEnabled()) {
    error(res, 404, 'Shadow routing is not enabled', 'shadow_routing_disabled');
    return;
  }

  if (req.method === 'GET') {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT * FROM shadow_experiments WHERE team_id = $1 ORDER BY created_at DESC`,
      [teamId],
    );
    json(res, 200, { experiments: rows });
    return;
  }

  if (req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof JsonBodyTooLargeError) {
        error(res, 413, err.message, 'request_body_too_large');
        return;
      }
      error(res, 400, 'Invalid JSON in request body', 'invalid_json');
      return;
    }

    const unknownFields = Object.keys(body).filter((field) => !POST_ALLOWED_FIELDS.has(field));
    if (unknownFields.length > 0) {
      error(res, 400, `Unknown create fields: ${unknownFields.join(', ')}`, 'invalid_field');
      return;
    }

    // Reject wildcard or mismatched tenant.
    const bodyTeam = body.team_id;
    if (bodyTeam !== undefined && (typeof bodyTeam !== 'string' || bodyTeam.trim() === '')) {
      error(res, 400, 'team_id must be a non-empty string when provided', 'invalid_tenant');
      return;
    }
    if (bodyTeam === '*' || bodyTeam === 'null' || bodyTeam === 'undefined') {
      error(res, 400, 'Wildcard tenant is not allowed', 'invalid_tenant');
      return;
    }
    if (typeof bodyTeam === 'string' && bodyTeam !== teamId) {
      error(res, 403, 'team_id in body does not match the global operator-selected team', 'tenant_mismatch');
      return;
    }

    // Validate required fields.
    const missing = REQUIRED_CREATE_FIELDS.filter((f) => {
      const v = body[f];
      return v === undefined || v === null || v === '';
    });
    if (missing.length > 0) {
      error(res, 400, `Missing required fields: ${missing.join(', ')}`, 'missing_fields');
      return;
    }

    for (const field of REQUIRED_TEXT_FIELDS) {
      if (typeof body[field] !== 'string' || body[field].trim() === '') {
        error(res, 400, `${field} must be a non-empty string`, 'invalid_field');
        return;
      }
    }
    if (body.created_by !== undefined && body.created_by !== null && typeof body.created_by !== 'string') {
      error(res, 400, 'created_by must be a string or null', 'invalid_field');
      return;
    }

    // Validate sample_rate_ppm range.
    const rate = body.sample_rate_ppm;
    if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 0 || rate > 1_000_000) {
      error(res, 400, 'sample_rate_ppm must be an integer in [0, 1000000]', 'invalid_sample_rate');
      return;
    }

    for (const field of EXECUTION_BOUND_FIELDS) {
      const value = body[field];
      const minimum = (POSITIVE_EXECUTION_BOUND_FIELDS as readonly string[]).includes(field) ? 1 : 0;
      const maximum = (POSTGRES_INTEGER_BOUND_FIELDS as readonly string[]).includes(field)
        ? POSTGRES_INTEGER_MAX
        : Number.MAX_SAFE_INTEGER;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        error(res, 400, `${field} must be a safe integer in [${minimum}, ${maximum}]`, 'invalid_execution_bound');
        return;
      }
    }
    const aggregateCap = body.aggregate_cap_microcents as number;
    const perRunCap = body.per_run_cap_microcents as number;
    if (aggregateCap < perRunCap) {
      error(res, 400, 'aggregate_cap_microcents must be >= per_run_cap_microcents', 'invalid_execution_bound');
      return;
    }

    for (const field of ['starts_at', 'ends_at'] as const) {
      if (!isOptionalTimestamp(body[field])) {
        error(res, 400, `${field} must be an ISO timestamp or null`, 'invalid_field');
        return;
      }
    }

    // funding_mode: only platform_funded in v1.
    if (body.funding_mode !== undefined && body.funding_mode !== 'platform_funded') {
      error(res, 400, "funding_mode must be 'platform_funded' in v1", 'invalid_funding_mode');
      return;
    }

    const id = randomUUID();
    const pool = getPool();
    const { rows } = await pool.query(
      `INSERT INTO shadow_experiments (
        id, team_id, name, enabled,
        source_provider, source_model, candidate_provider, candidate_model,
        sample_rate_ppm, sampling_version, shadow_sampling_key_version,
        starts_at, ends_at, max_samples,
        deadline_ms, max_concurrency, max_queue_count, max_queue_bytes, max_payload_bytes,
        funding_mode, per_run_cap_microcents, aggregate_cap_microcents,
        verifier_version, gate_fingerprint, created_by
      ) VALUES (
        $1, $2, $3, false,
        $4, $5, $6, $7,
        $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16, $17, $18,
        'platform_funded', $19, $20,
        $21, $22, $23
      ) RETURNING *`,
      [
        id, teamId, body.name,
        body.source_provider, body.source_model, body.candidate_provider, body.candidate_model,
        body.sample_rate_ppm, body.sampling_version, body.shadow_sampling_key_version,
        body.starts_at ?? null, body.ends_at ?? null, body.max_samples,
        body.deadline_ms, body.max_concurrency,
        body.max_queue_count, body.max_queue_bytes,
        body.max_payload_bytes,
        body.per_run_cap_microcents, body.aggregate_cap_microcents,
        body.verifier_version, body.gate_fingerprint,
        body.created_by ?? null,
      ],
    );
    json(res, 201, { experiment: rows[0] });
    return;
  }

  error(res, 405, 'Method not allowed', 'method_not_allowed');
}

/** PATCH/DELETE /admin/shadow-experiments/:id */
export async function handleShadowExperimentById(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  experimentId: string,
): Promise<void> {
  if (!isEnabled()) {
    error(res, 404, 'Shadow routing is not enabled', 'shadow_routing_disabled');
    return;
  }

  const pool = getPool();

  if (req.method === 'PATCH') {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof JsonBodyTooLargeError) {
        error(res, 413, err.message, 'request_body_too_large');
        return;
      }
      error(res, 400, 'Invalid JSON in request body', 'invalid_json');
      return;
    }

    // Immutable fields — cannot be changed after creation.
    const immutable = ['sampling_version', 'shadow_sampling_key_version', 'id', 'team_id'] as const;
    const attemptedImmutable = immutable.filter((f) => f in body);
    if (attemptedImmutable.length > 0) {
      error(res, 400, `Cannot modify immutable fields: ${attemptedImmutable.join(', ')}`, 'immutable_field');
      return;
    }

    // Build SET clause from allowed mutable fields.
    const allowed: Record<string, string> = {
      name: 'name',
      enabled: 'enabled',
      sample_rate_ppm: 'sample_rate_ppm',
      max_samples: 'max_samples',
      starts_at: 'starts_at',
      ends_at: 'ends_at',
      deadline_ms: 'deadline_ms',
      max_concurrency: 'max_concurrency',
      max_queue_count: 'max_queue_count',
      max_queue_bytes: 'max_queue_bytes',
      max_payload_bytes: 'max_payload_bytes',
      per_run_cap_microcents: 'per_run_cap_microcents',
      aggregate_cap_microcents: 'aggregate_cap_microcents',
      disabled_reason: 'disabled_reason',
      kill_switch_at: 'kill_switch_at',
    };

    const unknownFields = Object.keys(body).filter((field) => !Object.hasOwn(allowed, field));
    if (unknownFields.length > 0) {
      error(res, 400, `Unknown mutable fields: ${unknownFields.join(', ')}`, 'invalid_field');
      return;
    }

    if (Object.hasOwn(body, 'enabled')) {
      if (typeof body.enabled !== 'boolean') {
        error(res, 400, 'enabled must be a boolean', 'invalid_enabled');
        return;
      }
      // Phase 1 has no approved consent workflow. Never permit this inert
      // control plane to activate an experiment until that workflow exists.
      if (body.enabled) {
        error(
          res,
          409,
          'Shadow experiment enablement is unavailable until the approved consent workflow is implemented',
          'shadow_enablement_unavailable',
        );
        return;
      }
    }

    if (Object.hasOwn(body, 'name') && (typeof body.name !== 'string' || body.name.trim() === '')) {
      error(res, 400, 'name must be a non-empty string', 'invalid_field');
      return;
    }

    if (Object.hasOwn(body, 'sample_rate_ppm')) {
      const value = body.sample_rate_ppm;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
        error(res, 400, 'sample_rate_ppm must be an integer in [0, 1000000]', 'invalid_sample_rate');
        return;
      }
    }
    for (const field of EXECUTION_BOUND_FIELDS) {
      if (!Object.hasOwn(body, field)) continue;
      const value = body[field];
      const minimum = (POSITIVE_EXECUTION_BOUND_FIELDS as readonly string[]).includes(field) ? 1 : 0;
      const maximum = (POSTGRES_INTEGER_BOUND_FIELDS as readonly string[]).includes(field)
        ? POSTGRES_INTEGER_MAX
        : Number.MAX_SAFE_INTEGER;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
        error(res, 400, `${field} must be a safe integer in [${minimum}, ${maximum}]`, 'invalid_execution_bound');
        return;
      }
    }

    for (const field of OPTIONAL_TIMESTAMP_FIELDS) {
      if (!isOptionalTimestamp(body[field])) {
        error(res, 400, `${field} must be an ISO timestamp or null`, 'invalid_field');
        return;
      }
    }
    if (Object.hasOwn(body, 'disabled_reason') && body.disabled_reason !== null && typeof body.disabled_reason !== 'string') {
      error(res, 400, 'disabled_reason must be a string or null', 'invalid_field');
      return;
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const fieldParameterIndexes: Record<string, number> = {};
    let paramIdx = 1;

    for (const [bodyKey, col] of Object.entries(allowed)) {
      if (Object.hasOwn(body, bodyKey)) {
        sets.push(`${col} = $${paramIdx}`);
        values.push(body[bodyKey]);
        fieldParameterIndexes[bodyKey] = paramIdx;
        paramIdx++;
      }
    }

    if (sets.length === 0) {
      error(res, 400, 'No mutable fields provided', 'no_fields');
      return;
    }

    sets.push(`updated_at = now()`);
    values.push(teamId, experimentId);

    const boundValue = (field: typeof EXECUTION_BOUND_FIELDS[number]) => fieldParameterIndexes[field]
      ? `$${fieldParameterIndexes[field]}`
      : field;
    const boundContract = [
      `${boundValue('max_samples')} >= 0`,
      `${boundValue('deadline_ms')} > 0`,
      `${boundValue('max_concurrency')} > 0`,
      `${boundValue('max_queue_count')} >= 0`,
      `${boundValue('max_queue_bytes')} >= 0`,
      `${boundValue('max_payload_bytes')} > 0`,
      `${boundValue('per_run_cap_microcents')} >= 0`,
      `${boundValue('aggregate_cap_microcents')} >= ${boundValue('per_run_cap_microcents')}`,
    ].join(' AND ');
    const { rows } = await pool.query(
      `UPDATE shadow_experiments SET ${sets.join(', ')} WHERE team_id = $${paramIdx} AND id = $${paramIdx + 1} AND (${boundContract}) RETURNING *`,
      values,
    );

    if (rows.length === 0) {
      const diagnosticValues: unknown[] = [];
      const diagnosticParameterIndexes: Record<string, number> = {};
      for (const field of EXECUTION_BOUND_FIELDS) {
        if (Object.hasOwn(body, field)) {
          diagnosticValues.push(body[field]);
          diagnosticParameterIndexes[field] = diagnosticValues.length;
        }
      }
      const diagnosticBoundValue = (field: typeof EXECUTION_BOUND_FIELDS[number]) =>
        diagnosticParameterIndexes[field] ? `$${diagnosticParameterIndexes[field]}` : field;
      const diagnosticTeamParam = diagnosticValues.length + 1;
      diagnosticValues.push(teamId, experimentId);
      const existing = await pool.query(
        `SELECT concat_ws(', ',
          CASE WHEN ${diagnosticBoundValue('max_samples')} < 0 THEN 'max_samples' END,
          CASE WHEN ${diagnosticBoundValue('deadline_ms')} <= 0 THEN 'deadline_ms' END,
          CASE WHEN ${diagnosticBoundValue('max_concurrency')} <= 0 THEN 'max_concurrency' END,
          CASE WHEN ${diagnosticBoundValue('max_queue_count')} < 0 THEN 'max_queue_count' END,
          CASE WHEN ${diagnosticBoundValue('max_queue_bytes')} < 0 THEN 'max_queue_bytes' END,
          CASE WHEN ${diagnosticBoundValue('max_payload_bytes')} <= 0 THEN 'max_payload_bytes' END,
          CASE WHEN ${diagnosticBoundValue('per_run_cap_microcents')} < 0 THEN 'per_run_cap_microcents' END,
          CASE WHEN ${diagnosticBoundValue('aggregate_cap_microcents')} < ${diagnosticBoundValue('per_run_cap_microcents')}
            THEN 'aggregate_cap_microcents' END
        ) AS invalid_execution_bounds
        FROM shadow_experiments WHERE team_id = $${diagnosticTeamParam} AND id = $${diagnosticTeamParam + 1}`,
        diagnosticValues,
      );
      if (existing.rows.length > 0) {
        const invalidBounds = existing.rows[0]?.invalid_execution_bounds;
        const detail = typeof invalidBounds === 'string' && invalidBounds !== ''
          ? `: ${invalidBounds}`
          : '';
        error(
          res,
          400,
          `Execution-bound contract would be invalid${detail}; repair all invalid bounds atomically before annotations`,
          'invalid_execution_bound',
        );
      } else {
        error(res, 404, 'Experiment not found', 'not_found');
      }
      return;
    }
    json(res, 200, { experiment: rows[0] });
    return;
  }

  if (req.method === 'DELETE') {
    const { rowCount } = await pool.query(
      `DELETE FROM shadow_experiments WHERE team_id = $1 AND id = $2`,
      [teamId, experimentId],
    );
    if (rowCount === 0) {
      error(res, 404, 'Experiment not found', 'not_found');
      return;
    }
    json(res, 200, { deleted: true });
    return;
  }

  error(res, 405, 'Method not allowed', 'method_not_allowed');
}
