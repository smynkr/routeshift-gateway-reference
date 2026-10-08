// LAY-327: per-credential signal tracking.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetKeyStats,
  decrementInFlight,
  getInFlight,
  getLatencyStats,
  getProviderLatencySummary,
  incrementInFlight,
  recordLatency,
} from '../src/billing/key-stats.js';

beforeEach(() => {
  _resetKeyStats();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('latency tracking', () => {
  it('returns sampleCount=0 and Infinity when no samples exist', () => {
    const s = getLatencyStats('team', 'openai', 'a');
    expect(s.sampleCount).toBe(0);
    expect(s.p95LatencyMs).toBe(Infinity);
  });

  it('records and reports p95 over the recent window', () => {
    for (let i = 0; i < 20; i++) recordLatency('team', 'openai', 'a', 100 + i);
    const s = getLatencyStats('team', 'openai', 'a');
    expect(s.sampleCount).toBe(20);
    // p95 of [100..119] is around index 19 → 119
    expect(s.p95LatencyMs).toBeGreaterThanOrEqual(115);
  });

  it('drops samples older than the 5-minute window', () => {
    recordLatency('team', 'openai', 'a', 100);
    vi.advanceTimersByTime(6 * 60 * 1000);
    const s = getLatencyStats('team', 'openai', 'a');
    expect(s.sampleCount).toBe(0);
  });

  it('caps the per-key buffer at MAX_SAMPLES_PER_KEY (drops oldest)', () => {
    for (let i = 0; i < 200; i++) recordLatency('team', 'openai', 'a', i);
    const s = getLatencyStats('team', 'openai', 'a');
    expect(s.sampleCount).toBeLessThanOrEqual(100);
  });

  it('ignores non-finite or negative latency values', () => {
    recordLatency('team', 'openai', 'a', NaN);
    recordLatency('team', 'openai', 'a', -1);
    const s = getLatencyStats('team', 'openai', 'a');
    expect(s.sampleCount).toBe(0);
  });

  it('summarizes provider latency only when at least one credential is warm', () => {
    for (let i = 0; i < 12; i++) recordLatency('team', 'openai', 'fast', 100);
    for (let i = 0; i < 5; i++) recordLatency('team', 'openai', 'cold', 10);

    expect(getProviderLatencySummary('team', 'openai', ['fast', 'cold'])).toEqual({
      sampleCount: 17,
      p95LatencyMs: 100,
    });
    expect(getProviderLatencySummary('team', 'anthropic', ['cold'])).toEqual({
      sampleCount: 0,
      p95LatencyMs: undefined,
    });
  });
});

describe('in-flight counter', () => {
  it('starts at 0 and increments/decrements', () => {
    expect(getInFlight('team', 'openai', 'a')).toBe(0);
    incrementInFlight('team', 'openai', 'a');
    incrementInFlight('team', 'openai', 'a');
    expect(getInFlight('team', 'openai', 'a')).toBe(2);
    decrementInFlight('team', 'openai', 'a');
    expect(getInFlight('team', 'openai', 'a')).toBe(1);
  });

  it('removes the entry when the counter hits zero', () => {
    incrementInFlight('team', 'openai', 'a');
    decrementInFlight('team', 'openai', 'a');
    // Internal map should have purged the key — getInFlight returns 0.
    expect(getInFlight('team', 'openai', 'a')).toBe(0);
  });

  it('isolates counters per (team, provider, label)', () => {
    incrementInFlight('team_a', 'openai', 'a');
    incrementInFlight('team_a', 'openai', 'b');
    incrementInFlight('team_b', 'openai', 'a');
    incrementInFlight('team_a', 'anthropic', 'a');
    expect(getInFlight('team_a', 'openai', 'a')).toBe(1);
    expect(getInFlight('team_a', 'openai', 'b')).toBe(1);
    expect(getInFlight('team_b', 'openai', 'a')).toBe(1);
    expect(getInFlight('team_a', 'anthropic', 'a')).toBe(1);
  });
});
