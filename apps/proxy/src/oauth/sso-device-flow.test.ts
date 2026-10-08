import { describe, expect, it } from 'vitest';
import {
  DEVICE_CODE_TTL_SECONDS,
  DEFAULT_POLL_INTERVAL_SECONDS,
  SSO_KEY_TTL_HOURS,
  generateDeviceCode,
  hashDeviceCode,
  generateUserCode,
  formatUserCode,
  normalizeUserCode,
  generateOAuthState,
  isExpired,
  isPolledTooSoon,
} from './sso-device-flow.js';

describe('device code + user code', () => {
  it('generates a high-entropy device code and a stable hash of it', () => {
    const code = generateDeviceCode();
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceCode(code)).toBe(hashDeviceCode(code));
    expect(hashDeviceCode(code)).not.toBe(code);
  });

  it('generates a user code from the confusable-free alphabet at the expected length', () => {
    const code = generateUserCode();
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ23456789]{8}$/);
  });

  it('formats and normalizes a user code round-trip, case- and separator-insensitive', () => {
    const raw = generateUserCode();
    const formatted = formatUserCode(raw);
    expect(formatted).toContain('-');
    expect(normalizeUserCode(formatted.toLowerCase())).toBe(raw);
    expect(normalizeUserCode(` ${formatted} `)).toBe(raw);
  });
});

describe('generateOAuthState', () => {
  it('generates a high-entropy, URL-safe token', () => {
    const state = generateOAuthState();
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates distinct values across calls', () => {
    expect(generateOAuthState()).not.toBe(generateOAuthState());
  });
});

describe('isExpired', () => {
  it('is false before the deadline and true at/after it', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const deadline = new Date('2026-01-01T00:10:00Z');
    expect(isExpired(deadline, new Date('2026-01-01T00:09:59Z'))).toBe(false);
    expect(isExpired(deadline, now)).toBe(false);
    expect(isExpired(deadline, deadline)).toBe(true);
  });
});

describe('isPolledTooSoon', () => {
  it('is never too soon on the first poll', () => {
    expect(isPolledTooSoon(null, 5)).toBe(false);
  });

  it('is too soon inside the interval and not too soon after it', () => {
    const lastPolledAt = new Date('2026-01-01T00:00:00Z');
    expect(isPolledTooSoon(lastPolledAt, 5, new Date('2026-01-01T00:00:03Z'))).toBe(true);
    expect(isPolledTooSoon(lastPolledAt, 5, new Date('2026-01-01T00:00:06Z'))).toBe(false);
  });
});

describe('constants', () => {
  it('matches the RFC 8628 window and spec defaults', () => {
    expect(DEVICE_CODE_TTL_SECONDS).toBe(600);
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBe(5);
    expect(SSO_KEY_TTL_HOURS).toBe(8);
  });
});
