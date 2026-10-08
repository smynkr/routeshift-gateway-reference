import { createHash, randomBytes } from 'node:crypto';
import { getPool } from '../db/pool.js';
import { recordAuditEvent } from './audit-events.js';
import type { ApiKeyInfo } from './types.js';

const keyCache = new Map<string, { info: ApiKeyInfo; expires: number }>();
// Short TTL caps the window during which a revoked key keeps working.
// 5s is the smallest value that still meaningfully reduces DB load on
// burst traffic from a single key.
const CACHE_TTL_MS = 5_000;

const SWEEP_INTERVAL_MS = 60_000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of keyCache) {
    if (entry.expires <= now) keyCache.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(
  teamId: string,
  environment: 'live' | 'test' = 'live',
): { key: string; hash: string; prefix: string } {
  const random = randomBytes(16).toString('hex');
  const teamPrefix = teamId.slice(0, 4);
  const key = `sk-proxy-${environment}_${teamPrefix}_${random}`;
  const hash = hashApiKey(key);
  const prefix = `sk-proxy-${environment}_${teamPrefix}`;
  return { key, hash, prefix };
}

/**
 * RSH-86: typed infrastructure error for DB failures during auth.
 * Callers should surface this as 503, not the default 401 that `null`
 * would trigger — a DB blip or read-replica lag returning 0 rows is a
 * transient infrastructure fault, not an invalid key.
 */
export class AuthInfrastructureError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AuthInfrastructureError';
  }
}

export async function validateApiKey(key: string): Promise<ApiKeyInfo | null> {
  const hash = hashApiKey(key);

  const cached = keyCache.get(hash);
  if (cached && cached.expires > Date.now()) {
    return cached.info;
  }

  const pool = getPool();
  // LAY-339: a key inside a rotation grace window keeps validating until
  // rotation_grace_until elapses. After that it behaves like a revoked
  // key. NULL grace means "not in rotation" and matches the OR branch.
  let rows: any[];
  try {
    const result = await pool.query(
      `SELECT ak.id, ak.team_id, ak.allowed_models, ak.rate_limit_override, ak.metadata,
              ak.preset_slug, ak.preset_version
       FROM api_keys ak
       JOIN teams t ON ak.team_id = t.id
       WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL
         AND (ak.expires_at IS NULL OR ak.expires_at > now())
         AND (ak.rotation_grace_until IS NULL OR ak.rotation_grace_until > now())
         AND t.is_suspended = false`,
      [hash],
    );
    rows = result.rows;
  } catch (err) {
    // RSH-86: a DB connection error here must NOT map to 401 "Invalid API key".
    // Wrapping in a typed error lets proxy-handler.ts return 503 instead.
    throw new AuthInfrastructureError('API key validation failed due to infrastructure error', err);
  }

  if (rows.length === 0) {
    // LAY-331: audit-log the auth_failed attempt — best effort, dedup'd
    // to once per (team, prefix) per minute. We attribute the event to
    // the team that owns the prefix if any real key matches it; if not,
    // we skip emission (noise).
    void emitAuthFailedEvent(key);
    return null;
  }

  const row = rows[0];
  const info: ApiKeyInfo = {
    id: row.id,
    teamId: row.team_id,
    allowedModels: row.allowed_models,
    rateLimitOverride: row.rate_limit_override,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    presetSlug: typeof row.preset_slug === 'string' && row.preset_slug.length > 0 ? row.preset_slug : null,
    presetVersion: typeof row.preset_version === 'number' ? row.preset_version : null,
  };

  keyCache.set(hash, { info, expires: Date.now() + CACHE_TTL_MS });
  void pool.query('UPDATE api_keys SET last_used = now() WHERE id = $1', [row.id]).catch((err) => {
    console.error('Failed to update last_used for key:', row.id, err);
  });

  return info;
}

export function invalidateKeyCache(keyHash: string): void {
  keyCache.delete(keyHash);
}

export function clearKeyCache(): void {
  keyCache.clear();
}

/**
 * LAY-331: derive `sk-proxy-<env>_<teamPrefix>` from a raw key string. If
 * the format is unexpected, returns null and the audit emission is skipped.
 */
function extractKeyPrefix(rawKey: string): string | null {
  // Format: sk-proxy-<env>_<teamPrefix>_<random>
  if (!rawKey.startsWith('sk-proxy-')) return null;
  const parts = rawKey.split('_');
  if (parts.length < 3) return null;
  return `${parts[0]}_${parts[1]}`;
}

async function emitAuthFailedEvent(rawKey: string): Promise<void> {
  const prefix = extractKeyPrefix(rawKey);
  if (!prefix) return;
  try {
    const pool = getPool();
    // Attribute auth_failed to a team only when the *full key* matches an
    // existing row BY HASH (even if revoked/expired) — e.g. a genuine
    // revoked/expired key being reused. Matching on the attacker-supplied
    // prefix alone would let an attacker pollute another tenant's audit feed
    // and probe prefix existence, so an unknown key is just noise and we skip.
    const hash = hashApiKey(rawKey);
    const { rows } = await pool.query<{ team_id: string }>(
      `SELECT team_id FROM api_keys WHERE key_hash = $1 LIMIT 1`,
      [hash],
    );
    if (rows.length === 0) return;
    await recordAuditEvent({
      team_id: rows[0]!.team_id,
      api_key_id: null,
      key_prefix: prefix,
      event_type: 'auth_failed',
      details: {},
    });
  } catch (err) {
    console.warn('audit-events: auth_failed emission failed (non-fatal):', err);
  }
}
