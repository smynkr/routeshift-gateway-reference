import { getPool } from '../db/pool.js';
import {
  MAX_DIMENSIONS,
  MAX_SAMPLE_RATE_BPS,
  MIN_SAMPLE_RATE_BPS,
  type ClassifierConfig,
  type ClassifierDimension,
} from './types.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const configCache = new Map<string, { config: ClassifierConfig | null; expires: number }>();

function sanitizeDimensions(raw: unknown): ClassifierDimension[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_DIMENSIONS).filter(
    (d): d is ClassifierDimension =>
      typeof d === 'object' && d !== null &&
      typeof (d as any).id === 'string' &&
      typeof (d as any).name === 'string' &&
      Array.isArray((d as any).values) &&
      (d as any).values.length > 0,
  ).map((d) => ({
    id: d.id,
    name: d.name,
    prompt: typeof d.prompt === 'string' ? d.prompt : '',
    values: d.values.filter((v): v is string => typeof v === 'string'),
  }));
}

export async function getClassifierConfig(teamId: string): Promise<ClassifierConfig | null> {
  const cached = configCache.get(teamId);
  if (cached && cached.expires > Date.now()) return cached.config;

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT enabled, sample_rate_bps, classifier_provider, classifier_model, dimensions
     FROM team_classifier_configs WHERE team_id = $1`,
    [teamId],
  );

  let config: ClassifierConfig | null = null;
  if (rows.length > 0 && rows[0]!.enabled) {
    const row = rows[0]!;
    const dimensions = sanitizeDimensions(row.dimensions);
    if (dimensions.length > 0) {
      config = {
        teamId,
        enabled: true,
        sampleRateBps: Math.min(Math.max(Number(row.sample_rate_bps) || 1000, MIN_SAMPLE_RATE_BPS), MAX_SAMPLE_RATE_BPS),
        dimensions,
        classifierProvider: row.classifier_provider || 'openai',
        classifierModel: row.classifier_model || 'gpt-4.1-nano',
      };
    }
  }

  configCache.set(teamId, { config, expires: Date.now() + CACHE_TTL_MS });
  return config;
}

export function clearClassifierConfigCache(teamId?: string): void {
  if (teamId) configCache.delete(teamId);
  else configCache.clear();
}
