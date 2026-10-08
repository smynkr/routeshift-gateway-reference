import type { FallbackAttempt } from './log-attempts';
import { normalizeFallbackAttempts } from './log-attempts';

export type PluginWarning = { plugin: string; code: string; reason: string; message: string };

export type ActivityLog = {
  id: string;
  timestamp: string;
  provider: string;
  model_requested: string;
  model_resolved: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  original_cost_microcents: number;
  actual_cost_microcents: number;
  actual_cost_known: boolean;
  plugin_cost_microcents: number;
  billed_cost_microcents: number;
  savings_microcents: number;
  total_latency_ms: number;
  ttft_ms: number | null;
  is_streaming: boolean;
  is_fallback: boolean;
  fallback_attempts: FallbackAttempt[];
  plugin_warnings: PluginWarning[];
  status_code: number;
  error_type: string | null;
  cache_hit: boolean;
  activity_category: string | null;
  session_id: string | null;
  api_key_id: string | null;
};

export const ACTIVITY_LOG_SELECT = `
  id, timestamp, provider, model_requested, model_resolved,
  input_tokens, output_tokens, total_tokens,
  original_cost_microcents,
  actual_cost_microcents,
  actual_cost_known,
  COALESCE(plugin_cost_microcents, 0)::bigint AS plugin_cost_microcents,
  (actual_cost_microcents + COALESCE(plugin_cost_microcents, 0))::bigint AS billed_cost_microcents,
  savings_microcents,
  total_latency_ms, ttft_ms, is_streaming, is_fallback,
  fallback_attempts, plugin_warnings,
  status_code, error_type,
  COALESCE(cache_hit, false) AS cache_hit,
  activity_category,
  session_id,
  api_key_id`;

function isPluginWarning(value: unknown): value is PluginWarning {
  if (!value || typeof value !== 'object') return false;
  if (!('plugin' in value) || !('code' in value) || !('reason' in value) || !('message' in value)) {
    return false;
  }
  return (
    typeof value.plugin === 'string' &&
    typeof value.code === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.message === 'string'
  );
}

export function normalizePluginWarnings(value: unknown): PluginWarning[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((warning) => (
    isPluginWarning(warning)
      ? [{ plugin: warning.plugin, code: warning.code, reason: warning.reason, message: warning.message }]
      : []
  ));
}

export function mapActivityLogRow(row: Record<string, unknown>): ActivityLog {
  return {
    id: String(row.id),
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : String(row.timestamp),
    provider: String(row.provider),
    model_requested: String(row.model_requested),
    model_resolved: String(row.model_resolved),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    total_tokens: Number(row.total_tokens),
    original_cost_microcents: Number(row.original_cost_microcents),
    actual_cost_microcents: Number(row.actual_cost_microcents),
    actual_cost_known: row.actual_cost_known === true || row.actual_cost_known === 1,
    plugin_cost_microcents: Number(row.plugin_cost_microcents),
    billed_cost_microcents: Number(row.billed_cost_microcents),
    savings_microcents: Number(row.savings_microcents),
    total_latency_ms: Number(row.total_latency_ms),
    ttft_ms: row.ttft_ms == null ? null : Number(row.ttft_ms),
    is_streaming: row.is_streaming === true,
    is_fallback: row.is_fallback === true,
    fallback_attempts: normalizeFallbackAttempts(row.fallback_attempts),
    plugin_warnings: normalizePluginWarnings(row.plugin_warnings),
    status_code: Number(row.status_code),
    error_type: typeof row.error_type === 'string' ? row.error_type : null,
    cache_hit: row.cache_hit === true,
    activity_category: typeof row.activity_category === 'string' ? row.activity_category : null,
    session_id: typeof row.session_id === 'string' ? row.session_id : null,
    api_key_id: typeof row.api_key_id === 'string' ? row.api_key_id : null,
  };
}

export const MICROCENTS_TO_USD = 100_000_000;

export function formatCost(microcents: number): string {
  const usd = microcents / MICROCENTS_TO_USD;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatObservedCost(
  log: Pick<ActivityLog, 'actual_cost_known'>,
  microcents: number,
): string {
  const cost = formatCost(microcents);
  return log.actual_cost_known ? cost : `Observed lower bound: ${cost}`;
}

export function shouldShowRoutingSavings(
  log: Pick<ActivityLog, 'actual_cost_known' | 'savings_microcents'>,
): boolean {
  return log.actual_cost_known && log.savings_microcents > 0;
}
