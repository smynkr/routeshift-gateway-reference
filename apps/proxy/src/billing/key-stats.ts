// LAY-327: per-credential signal tracking for latency-based and
// least-busy selection strategies.
//
// State is in-memory and bounded:
//
// - latency: ring buffer of last 100 (timestamp, latency_ms) samples per
//   (team, provider, label). Old samples (>5 min) are filtered on read so
//   the p95 reflects recent traffic.
// - in-flight: simple counter incremented before fetch, decremented in
//   the request's `finally`. Tracks concurrent dispatches.
//
// Both are reset by `_resetKeyStats()` for tests. No DB persistence —
// matches the existing rate-limiter / circuit-breaker / cooldown design;
// a fresh process starts with empty state and ramps within seconds.

const SAMPLE_WINDOW_MS = 5 * 60 * 1000;
const MAX_SAMPLES_PER_KEY = 100;
const MIN_SAMPLES_FOR_LATENCY_PICK = 10;

interface LatencySample {
  at: number;
  latencyMs: number;
}

const latencyByKey = new Map<string, LatencySample[]>();
const inFlightByKey = new Map<string, number>();

function k(teamId: string, provider: string, label: string): string {
  return `${teamId}:${provider}:${label}`;
}

export function recordLatency(
  teamId: string,
  provider: string,
  label: string,
  latencyMs: number,
): void {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  const key = k(teamId, provider, label);
  const arr = latencyByKey.get(key) ?? [];
  arr.push({ at: Date.now(), latencyMs });
  // Drop oldest beyond the cap so an old idle bucket can't grow without
  // bound between reads.
  if (arr.length > MAX_SAMPLES_PER_KEY) arr.splice(0, arr.length - MAX_SAMPLES_PER_KEY);
  latencyByKey.set(key, arr);
}

export function incrementInFlight(teamId: string, provider: string, label: string): void {
  const key = k(teamId, provider, label);
  inFlightByKey.set(key, (inFlightByKey.get(key) ?? 0) + 1);
}

export function decrementInFlight(teamId: string, provider: string, label: string): void {
  const key = k(teamId, provider, label);
  const current = inFlightByKey.get(key) ?? 0;
  if (current <= 1) inFlightByKey.delete(key);
  else inFlightByKey.set(key, current - 1);
}

export interface KeyLatencyStats {
  /** Number of samples in the recent window. Falls below MIN_SAMPLES_FOR_LATENCY_PICK → use WRR fallback. */
  sampleCount: number;
  /** p95 of latency in the recent window. Infinity when no samples. */
  p95LatencyMs: number;
}

export function getLatencyStats(teamId: string, provider: string, label: string): KeyLatencyStats {
  const key = k(teamId, provider, label);
  const arr = latencyByKey.get(key);
  if (!arr || arr.length === 0) return { sampleCount: 0, p95LatencyMs: Infinity };

  const cutoff = Date.now() - SAMPLE_WINDOW_MS;
  const recent = arr.filter((s) => s.at >= cutoff);
  // Reap the old samples in-place so the next read doesn't re-walk them.
  if (recent.length !== arr.length) {
    if (recent.length === 0) latencyByKey.delete(key);
    else latencyByKey.set(key, recent);
  }
  if (recent.length === 0) return { sampleCount: 0, p95LatencyMs: Infinity };

  const sorted = recent.map((s) => s.latencyMs).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return { sampleCount: recent.length, p95LatencyMs: sorted[idx]! };
}

export function getInFlight(teamId: string, provider: string, label: string): number {
  return inFlightByKey.get(k(teamId, provider, label)) ?? 0;
}

export const LATENCY_MIN_SAMPLES = MIN_SAMPLES_FOR_LATENCY_PICK;

export interface ProviderLatencySummary {
  sampleCount: number;
  p95LatencyMs?: number;
}

export function getProviderLatencySummary(
  teamId: string,
  provider: string,
  labels: string[],
): ProviderLatencySummary {
  let sampleCount = 0;
  let bestP95 = Infinity;
  for (const label of labels) {
    const stats = getLatencyStats(teamId, provider, label);
    sampleCount += stats.sampleCount;
    if (stats.sampleCount >= LATENCY_MIN_SAMPLES && stats.p95LatencyMs < bestP95) {
      bestP95 = stats.p95LatencyMs;
    }
  }
  return {
    sampleCount,
    p95LatencyMs: Number.isFinite(bestP95) ? bestP95 : undefined,
  };
}

/** @internal — for testing only */
export function _resetKeyStats(): void {
  latencyByKey.clear();
  inFlightByKey.clear();
}
