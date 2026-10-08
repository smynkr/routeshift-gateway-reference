import { getPool } from '../db/pool.js';

const CACHE_TTL_MS = 60 * 1000;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PRESET_VERSION = 2_147_483_647;

export type PresetParams = Record<string, unknown>;
// JSONB is not schema-constrained at the database layer. Preserve its raw
// shape through resolution so the request handler can reject malformed stored
// provider preferences instead of silently treating them as no preferences.
export type ProviderPrefs = unknown;

export interface ResolvedPreset {
  model: string;
  params: PresetParams;
  system_prompt?: string;
  provider_prefs?: ProviderPrefs;
}

interface PresetRef {
  slug: string;
  version?: number;
}

interface CacheEntry {
  value: ResolvedPreset | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(teamId: string, ref: string): string {
  return `${teamId}:${ref}`;
}

export function parsePresetRef(ref: string): PresetRef | null {
  const at = ref.lastIndexOf('@');
  const slug = at === -1 ? ref : ref.slice(0, at);
  const versionText = at === -1 ? undefined : ref.slice(at + 1);

  if (!SLUG_RE.test(slug)) return null;
  if (versionText === undefined) return { slug };
  if (!/^\d+$/.test(versionText)) return null;
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version <= 0 || version > MAX_PRESET_VERSION) return null;
  return { slug, version };
}

function normalizeRow(row: {
  model: string;
  params: unknown;
  system_prompt: string | null;
  provider_prefs: unknown;
}): ResolvedPreset {
  return {
    model: row.model,
    params: isObject(row.params) ? row.params : {},
    system_prompt: row.system_prompt ?? undefined,
    provider_prefs: row.provider_prefs ?? undefined,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function resolvePreset(
  teamId: string,
  ref: string,
  options: { bypassCache?: boolean } = {},
): Promise<ResolvedPreset | null> {
  const parsed = parsePresetRef(ref);
  if (!parsed) return null;

  const key = cacheKey(teamId, ref);
  const cached = cache.get(key);
  if (!options.bypassCache && cached && cached.expiresAt > Date.now()) return cached.value;

  const pool = getPool();
  const result = parsed.version === undefined
    ? await pool.query<{
        model: string;
        params: unknown;
        system_prompt: string | null;
        provider_prefs: unknown;
      }>(
        `SELECT model, params, system_prompt, provider_prefs
         FROM presets
         WHERE team_id = $1 AND slug = $2 AND enabled = true`,
        [teamId, parsed.slug],
      )
    : await pool.query<{
        model: string;
        params: unknown;
        system_prompt: string | null;
        provider_prefs: unknown;
      }>(
        `SELECT pv.model, pv.params, pv.system_prompt, pv.provider_prefs
         FROM preset_versions pv
         JOIN presets p ON p.id = pv.preset_id
         WHERE pv.team_id = $1 AND p.team_id = $1 AND p.slug = $2 AND pv.version = $3 AND p.enabled = true`,
        [teamId, parsed.slug, parsed.version],
      );

  const value = result.rows[0] ? normalizeRow(result.rows[0]) : null;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function invalidatePresetCache(teamId?: string): void {
  if (!teamId) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${teamId}:`)) cache.delete(key);
  }
}
