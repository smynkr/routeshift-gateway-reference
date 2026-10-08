interface RateLimitConfig {
  requestsPerMinute: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

// LAY-330: TPM (tokens-per-minute) result. recordId lets the proxy reconcile
// the pre-flight estimate with the actual usage once the upstream response
// returns, so a request that estimated 1k tokens but used 5k can't burst the
// next request through.
export interface TpmResult {
  allowed: boolean;
  /** Null when no TPM cap was set, or when the request was denied. */
  recordId: string | null;
  /** Tokens already consumed in the current 60s window (excluding this request). */
  currentTokens: number;
  /** Remaining tokens after this request. Infinity when no cap. */
  remaining: number;
  resetMs: number;
}

interface TokenEntry {
  at: number;
  tokens: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  requestsPerMinute: 100,
  windowMs: 60_000,
};

export class RateLimiter {
  private windows = new Map<string, number[]>();
  private tokenWindows = new Map<string, TokenEntry[]>();
  // Request-scoped pointers into tokenWindows so reconcileActualTokens()
  // can update an entry in-place. Bounded by request lifetime; cleared on
  // reconcile or by the sweep below.
  private tokenRecords = new Map<string, { teamId: string; entry: TokenEntry }>();
  private config: RateLimitConfig;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    const sweepTimer = setInterval(() => {
      const now = Date.now();
      const windowStart = now - this.config.windowMs;
      for (const [key, timestamps] of this.windows) {
        const filtered = timestamps.filter((t) => t > windowStart);
        if (filtered.length === 0) this.windows.delete(key);
        else this.windows.set(key, filtered);
      }
      for (const [key, entries] of this.tokenWindows) {
        const filtered = entries.filter((e) => e.at > windowStart);
        if (filtered.length === 0) this.tokenWindows.delete(key);
        else this.tokenWindows.set(key, filtered);
      }
      // Records older than the window can never be reconciled meaningfully.
      for (const [rid, { entry }] of this.tokenRecords) {
        if (entry.at <= windowStart) this.tokenRecords.delete(rid);
      }
    }, 60_000);
    sweepTimer.unref();
  }

  check(teamId: string, overrideRpm?: number): RateLimitResult {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const rpm = overrideRpm ?? this.config.requestsPerMinute;

    const existing = this.windows.get(teamId);
    let timestamps = existing ? existing.filter(t => t > windowStart) : [];
    if (existing && timestamps.length === 0) {
      // Stale bucket fully aged out. Start a fresh window but RECORD this request
      // — returning allowed WITHOUT recording it handed out a free request, so an
      // idle-then-resume team got rpm+1 admitted in the new window.
      this.windows.set(teamId, [now]);
      return { allowed: true, remaining: rpm - 1, resetMs: this.config.windowMs };
    }

    if (timestamps.length >= rpm) {
      const oldestInWindow = timestamps[0];
      const resetMs = (oldestInWindow + this.config.windowMs) - now;
      this.windows.set(teamId, timestamps);
      return { allowed: false, remaining: 0, resetMs: Math.max(0, resetMs) };
    }

    timestamps.push(now);
    this.windows.set(teamId, timestamps);

    return {
      allowed: true,
      remaining: rpm - timestamps.length,
      resetMs: this.config.windowMs - (now - timestamps[0]),
    };
  }

  /**
   * LAY-330: token-budget pre-flight check. Estimates the request's input
   * cost from the canonical messages (caller does the math), adds it to the
   * 60s rolling window, and rejects with 429 when the estimate would push
   * the window over the cap.
   *
   * Returns a recordId; pass it to reconcileActualTokens() once the upstream
   * response provides actual usage so subsequent requests see the accurate
   * count instead of the estimate.
   *
   * When `overrideTpm` is undefined, no cap applies — the request always
   * passes and recordId is null. This keeps the call site cheap when the
   * key has no TPM override (the common case today).
   */
  checkTpm(teamId: string, estimatedTokens: number, overrideTpm?: number): TpmResult {
    if (overrideTpm === undefined || overrideTpm === null) {
      return {
        allowed: true,
        recordId: null,
        currentTokens: 0,
        remaining: Infinity,
        resetMs: 0,
      };
    }

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const existing = this.tokenWindows.get(teamId) ?? [];
    const filtered = existing.filter((e) => e.at > windowStart);
    const used = filtered.reduce((s, e) => s + e.tokens, 0);

    if (used + estimatedTokens > overrideTpm) {
      const oldestAt = filtered.length > 0 ? filtered[0]!.at : now;
      // Keep the filtered entries so the next call doesn't re-walk an
      // unfiltered window.
      this.tokenWindows.set(teamId, filtered);
      return {
        allowed: false,
        recordId: null,
        currentTokens: used,
        remaining: Math.max(0, overrideTpm - used),
        resetMs: Math.max(0, oldestAt + this.config.windowMs - now),
      };
    }

    const entry: TokenEntry = { at: now, tokens: Math.max(0, estimatedTokens) };
    filtered.push(entry);
    this.tokenWindows.set(teamId, filtered);

    const recordId = `${teamId}:${now}:${Math.random().toString(36).slice(2, 10)}`;
    this.tokenRecords.set(recordId, { teamId, entry });

    return {
      allowed: true,
      recordId,
      currentTokens: used + entry.tokens,
      remaining: overrideTpm - used - entry.tokens,
      resetMs: this.config.windowMs,
    };
  }

  /**
   * Replace a request's pre-upstream estimate once a bounded local
   * augmentation (for example PDF extraction) has produced the canonical
   * payload. Keeping the same record id is important: success later reconciles
   * this one reservation to provider-reported usage instead of double-counting
   * an initial estimate plus an adjustment entry.
   */
  updateTpmEstimate(recordId: string | null, estimatedTokens: number, limit?: number): TpmResult {
    if (!recordId || limit === undefined || limit === null) {
      return {
        allowed: true,
        recordId,
        currentTokens: 0,
        remaining: Infinity,
        resetMs: 0,
      };
    }

    const record = this.tokenRecords.get(recordId);
    if (!record) {
      // A record can age out only after the rolling window; accepting here is
      // safe because the original reservation is no longer counted either.
      return {
        allowed: true,
        recordId,
        currentTokens: 0,
        remaining: limit,
        resetMs: 0,
      };
    }

    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const entries = (this.tokenWindows.get(record.teamId) ?? []).filter((entry) => entry.at > windowStart);
    this.tokenWindows.set(record.teamId, entries);
    const usedWithoutThisRequest = entries.reduce(
      (sum, entry) => sum + (entry === record.entry ? 0 : entry.tokens),
      0,
    );
    const nextTokens = Math.max(0, estimatedTokens);
    if (usedWithoutThisRequest + nextTokens > limit) {
      const oldestAt = entries.length > 0 ? entries[0]!.at : now;
      return {
        allowed: false,
        recordId: null,
        currentTokens: usedWithoutThisRequest + record.entry.tokens,
        remaining: Math.max(0, limit - usedWithoutThisRequest),
        resetMs: Math.max(0, oldestAt + this.config.windowMs - now),
      };
    }

    record.entry.tokens = nextTokens;
    return {
      allowed: true,
      recordId,
      currentTokens: usedWithoutThisRequest + nextTokens,
      remaining: limit - usedWithoutThisRequest - nextTokens,
      resetMs: this.config.windowMs,
    };
  }

  /**
   * Reconcile the pre-flight estimate with the actual upstream-reported
   * input-token count. Called once per request after the upstream response
   * returns usage. Quietly does nothing for null recordIds or recordIds
   * already swept.
   */
  reconcileActualTokens(
    recordId: string | null | Array<string | null>,
    actualTokens: number,
  ): void {
    // LAY-348: accept multiple ids so a request that consumed both the
    // per-key and team-wide TPM buckets reconciles each bucket's pre-flight
    // estimate with the upstream's actual count in one call.
    const ids = Array.isArray(recordId) ? recordId : [recordId];
    for (const id of ids) {
      if (!id) continue;
      const record = this.tokenRecords.get(id);
      if (!record) continue;
      record.entry.tokens = Math.max(0, actualTokens);
      this.tokenRecords.delete(id);
    }
  }

  /**
   * Drop a pre-flight estimate WITHOUT reconciling it. Used when a later gating
   * check (e.g. the team-wide TPM check) rejects a request after the per-key
   * check already recorded its estimate — otherwise the per-key bucket carries a
   * phantom entry for a request that never went upstream (RSH-60). No-ops on a
   * null/unknown id (e.g. when the key had no TPM override, recordId is null).
   */
  removeRecord(recordId: string | null): void {
    if (!recordId) return;
    const record = this.tokenRecords.get(recordId);
    if (!record) return;
    const window = this.tokenWindows.get(record.teamId);
    if (window) {
      const idx = window.indexOf(record.entry);
      if (idx !== -1) window.splice(idx, 1);
    }
    this.tokenRecords.delete(recordId);
  }
}

export const rateLimiter = new RateLimiter();
