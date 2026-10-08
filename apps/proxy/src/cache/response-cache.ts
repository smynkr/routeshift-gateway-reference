import { createHash } from 'node:crypto';
import type { CanonicalRequest } from '@routeshift/shared';

interface CacheEntry {
  body: any;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number; reasoning_tokens?: number };
  teamId: string;
  provider: string;
  model: string;
  storedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 2000;
const SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute

class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private sweepTimer: NodeJS.Timeout;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Allow process to exit without waiting for the timer
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /**
   * Determine if a request is cacheable.
   * Only non-streaming, deterministic (temperature EXPLICITLY 0), non-tool
   * requests. An omitted temperature is NOT 0 — providers sample at their
   * default (~1.0), so caching it would replay a non-deterministic generation
   * for the whole TTL (RSH-59). Require an explicit 0.
   */
  isCacheable(canonical: CanonicalRequest): boolean {
    if (canonical.stream) return false;
    if (canonical.tools && canonical.tools.length > 0) return false;
    if (canonical.temperature !== 0) return false;
    return true;
  }

  /**
   * Build a cache key from team ID + canonical request content. Provider is
   * included because provider preferences can route the same canonical model to
   * endpoints with different data policies/costs/response behavior.
   */
  buildKey(teamId: string, canonical: CanonicalRequest, provider?: string): string {
    const payload = JSON.stringify({
      t: teamId,
      p: provider ?? '',
      m: canonical.model,
      msgs: canonical.messages,
      sys: canonical.system_prompt ?? '',
      max: canonical.max_output_tokens ?? 0,
      tc: canonical.tool_choice ?? '',
      rf: canonical.response_format ?? null,
      pp: canonical.provider_params ?? null,
      // reasoning_effort / thinking_budget_tokens are top-level canonical
      // fields (not provider_params) that are forwarded to the provider and
      // materially change the generation. Without them in the key a low-effort
      // response could be replayed for a later high-effort request (RSH-79).
      re: canonical.reasoning_effort ?? '',
      tl: canonical.thinking_level ?? '',
      tb: canonical.thinking_budget_tokens ?? 0,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  get(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    // Move to end for LRU behavior (re-insert refreshes insertion order)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry;
  }

  set(key: string, entry: Omit<CacheEntry, 'storedAt'>): void {
    // Evict oldest entry if at capacity
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, { ...entry, storedAt: Date.now() });
  }

  invalidateTeam(teamId: string, provider?: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.teamId === teamId && (!provider || entry.provider === provider)) {
        this.cache.delete(key);
      }
    }
  }

  /** Purge expired entries to prevent memory leaks. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.storedAt > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  get stats() {
    return { total: this.cache.size, maxEntries: MAX_ENTRIES };
  }

  clear(): void {
    this.cache.clear();
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
  }
}

export const responseCache = new ResponseCache();
