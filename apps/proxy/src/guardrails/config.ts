import { getPool } from '../db/pool.js';
import type { GuardrailConfig } from './scanner.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const configCache = new Map<string, { config: GuardrailConfig | null; expires: number }>();

export async function getGuardrailConfig(teamId: string): Promise<GuardrailConfig | null> {
  const cached = configCache.get(teamId);
  if (cached && cached.expires > Date.now()) return cached.config;

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT enabled, config FROM team_guardrail_configs WHERE team_id = $1`,
    [teamId],
  );

  let config: GuardrailConfig | null = null;
  if (rows.length > 0 && rows[0]!.enabled) {
    const raw = rows[0]!.config ?? {};
    config = {
      enabled: true,
      patterns: Array.isArray(raw.patterns) ? raw.patterns : [],
    };
  }

  configCache.set(teamId, { config, expires: Date.now() + CACHE_TTL_MS });
  return config;
}

export function clearGuardrailConfigCache(teamId?: string): void {
  if (teamId) configCache.delete(teamId);
  else configCache.clear();
}
