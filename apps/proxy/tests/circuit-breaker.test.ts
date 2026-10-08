import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from '../src/routing/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker({ failureThreshold: 3, failureWindowMs: 60000, cooldownMs: 5000 });
  });

  it('starts in closed state', () => {
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(false);
  });

  it('stays closed below failure threshold', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(false);
  });

  it('opens after reaching failure threshold', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(true);
  });

  it('isolates circuits per provider+model', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(true);
    expect(cb.isOpen('anthropic', 'claude-haiku-4-5')).toBe(false);
  });

  it('resets to closed on successful probe', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(true);

    cb.recordSuccess('openai', 'gpt-4.1');
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(false);
  });

  it('clears failure count on success', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordSuccess('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    // Should not be open — success reset the count
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(false);
  });

  it('returns state info', () => {
    const state = cb.getState('openai', 'gpt-4.1');
    expect(state).toEqual({ state: 'closed', failures: 0 });

    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    const openState = cb.getState('openai', 'gpt-4.1');
    expect(openState.state).toBe('open');
    expect(openState.failures).toBe(3);
  });

  it('half-open: allows probe after cooldown expires', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(true);

    // Advance time past cooldown (5000ms)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6000);

    // Should transition to half_open and allow probe (return false)
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(false);
    expect(cb.getState('openai', 'gpt-4.1').state).toBe('half_open');

    vi.useRealTimers();
  });

  it('half-open to closed: successful probe closes circuit', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6000);

    // Transition to half_open
    cb.isOpen('openai', 'gpt-4.1');
    expect(cb.getState('openai', 'gpt-4.1').state).toBe('half_open');

    // Successful probe
    cb.recordSuccess('openai', 'gpt-4.1');
    expect(cb.getState('openai', 'gpt-4.1').state).toBe('closed');
    expect(cb.getState('openai', 'gpt-4.1').failures).toBe(0);
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(false);

    vi.useRealTimers();
  });

  it('half-open to open: failed probe re-opens circuit', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6000);

    // Transition to half_open
    cb.isOpen('openai', 'gpt-4.1');
    expect(cb.getState('openai', 'gpt-4.1').state).toBe('half_open');

    // Failed probe should re-open
    cb.recordFailure('openai', 'gpt-4.1');
    expect(cb.getState('openai', 'gpt-4.1').state).toBe('open');

    vi.useRealTimers();
  });

  it('multiple concurrent requests during half-open: only one probe allowed', () => {
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');
    cb.recordFailure('openai', 'gpt-4.1');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6000);

    // First call transitions to half_open and allows the single probe
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(false); // probe allowed
    expect(cb.getState('openai', 'gpt-4.1').state).toBe('half_open');

    // Second call while probe is in-flight should be blocked to prevent
    // flooding a recovering provider with concurrent requests.
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(true);

    // After the probe fails, circuit re-opens and probe flag is cleared
    cb.recordFailure('openai', 'gpt-4.1');
    expect(cb.getState('openai', 'gpt-4.1').state).toBe('open');
    // Now within cooldown, isOpen should be true
    expect(cb.isOpen('openai', 'gpt-4.1')).toBe(true);

    vi.useRealTimers();
  });

  describe('Percentage Mode', () => {
    let pcb: CircuitBreaker;

    beforeEach(() => {
      pcb = new CircuitBreaker({
        failureThresholdPercentage: 0.5, // 50%
        minimumRequests: 4,
        failureWindowMs: 60000,
        cooldownMs: 5000,
      });
    });

    it('does not open if below minimum requests floor', () => {
      pcb.recordFailure('anthropic', 'claude-3');
      pcb.recordFailure('anthropic', 'claude-3');
      pcb.recordFailure('anthropic', 'claude-3');
      // 3 failures, 100% failure rate, but min requests is 4
      expect(pcb.isOpen('anthropic', 'claude-3')).toBe(false);
    });

    it('opens if failure rate exceeds threshold after minimum requests', () => {
      pcb.recordFailure('anthropic', 'claude-3');
      pcb.recordFailure('anthropic', 'claude-3');
      pcb.recordSuccess('anthropic', 'claude-3');
      pcb.recordFailure('anthropic', 'claude-3');
      // 4 requests (3 failures, 1 success) -> 75% failure rate >= 50%. Trips on the final failure.
      expect(pcb.isOpen('anthropic', 'claude-3')).toBe(true);
    });

    it('stays closed if failure rate is below threshold after minimum requests', () => {
      pcb.recordFailure('anthropic', 'claude-3');
      pcb.recordSuccess('anthropic', 'claude-3');
      pcb.recordSuccess('anthropic', 'claude-3');
      pcb.recordSuccess('anthropic', 'claude-3');
      // 4 requests (1 failure, 3 successes) -> 25% failure rate < 50%
      expect(pcb.isOpen('anthropic', 'claude-3')).toBe(false);
    });
  });
});
