interface CircuitState {
  failures: number;
  failureTimestamps: number[]; // Failure timestamps for windowed counting
  successTimestamps: number[]; // Success timestamps for percentage mode
  state: 'closed' | 'open' | 'half_open';
  openedAt: number;
  probeInFlight: boolean; // True when a half-open probe is pending resolution
}

interface CircuitBreakerConfig {
  failureThreshold: number;  // Failures to trigger open
  failureThresholdPercentage?: number; // E.g. 0.20 for 20%
  minimumRequests?: number;  // Floor before percentage check
  failureWindowMs: number;   // Window for counting failures
  cooldownMs: number;        // Time before allowing probe
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
};

export class CircuitBreaker {
  private circuits = new Map<string, CircuitState>();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private key(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  private getOrCreate(provider: string, model: string): CircuitState {
    const k = this.key(provider, model);
    let state = this.circuits.get(k);
    if (!state) {
      state = { failures: 0, failureTimestamps: [], successTimestamps: [], state: 'closed', openedAt: 0, probeInFlight: false };
      this.circuits.set(k, state);
    }
    return state;
  }

  isOpen(provider: string, model: string): boolean {
    const state = this.getOrCreate(provider, model);
    if (state.state === 'closed') return false;
    if (state.state === 'half_open') {
      // Only allow one probe through; block concurrent callers until the
      // probe resolves via recordSuccess/recordFailure.
      if (state.probeInFlight) return true;
      state.probeInFlight = true;
      return false;
    }

    // Check if cooldown has elapsed — transition to half_open and allow exactly one probe
    if (Date.now() - state.openedAt >= this.config.cooldownMs) {
      state.state = 'half_open';
      state.probeInFlight = true;
      return false;
    }

    return true;
  }

  recordFailure(provider: string, model: string): void {
    const state = this.getOrCreate(provider, model);
    const now = Date.now();

    // If half_open probe failed, re-open immediately
    if (state.state === 'half_open') {
      state.state = 'open';
      state.openedAt = now;
      state.probeInFlight = false;
      return;
    }

    // Add failure timestamp, prune old ones outside window
    state.failureTimestamps.push(now);
    state.failureTimestamps = state.failureTimestamps.filter(t => now - t < this.config.failureWindowMs);
    state.successTimestamps = state.successTimestamps.filter(t => now - t < this.config.failureWindowMs);
    state.failures = state.failureTimestamps.length;

    let shouldOpen = false;
    if (this.config.failureThresholdPercentage !== undefined && this.config.minimumRequests !== undefined) {
      const totalRequests = state.failureTimestamps.length + state.successTimestamps.length;
      if (totalRequests >= this.config.minimumRequests) {
        const failureRate = state.failureTimestamps.length / totalRequests;
        if (failureRate >= this.config.failureThresholdPercentage) {
          shouldOpen = true;
        }
      }
    } else {
      if (state.failures >= this.config.failureThreshold) {
        shouldOpen = true;
      }
    }

    if (shouldOpen) {
      state.state = 'open';
      state.openedAt = now;
    }
  }

  recordSuccess(provider: string, model: string): void {
    const state = this.getOrCreate(provider, model);
    const now = Date.now();

    if (state.state === 'half_open') {
      // Successful probe clears history to start fresh
      state.failures = 0;
      state.failureTimestamps = [];
      state.successTimestamps = [];
      state.state = 'closed';
      state.openedAt = 0;
      state.probeInFlight = false;
      return;
    }

    // If not in percentage mode, a normal success resets the failure count (consecutive failures semantics)
    if (this.config.failureThresholdPercentage === undefined) {
      state.failures = 0;
      state.failureTimestamps = [];
      state.successTimestamps = [];
      state.state = 'closed';
      state.openedAt = 0;
      return;
    }

    // In percentage mode, record success for percentage calculation but don't clear failures
    state.successTimestamps.push(now);
    state.successTimestamps = state.successTimestamps.filter(t => now - t < this.config.failureWindowMs);
    state.failureTimestamps = state.failureTimestamps.filter(t => now - t < this.config.failureWindowMs);
    state.failures = state.failureTimestamps.length;
  }

  getState(provider: string, model: string): { state: string; failures: number } {
    const s = this.getOrCreate(provider, model);
    return { state: s.state, failures: s.failures };
  }
}

// Singleton instance
export const circuitBreaker = new CircuitBreaker();
