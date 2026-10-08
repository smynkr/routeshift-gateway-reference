import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEVICE_SCOPE_MAX_LENGTH,
  DEVICE_CODE_TTL_SECONDS,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  formatUserCode,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  isExpired,
  isPolledTooSoon,
  mintedKeyTtlHours,
  normalizeUserCode,
  normalizeDeviceScope,
  parseScopes,
} from '@/lib/oauth-device';

describe('device code', () => {
  it('generates a 64-hex-char (256-bit) secret', () => {
    const code = generateDeviceCode();
    expect(code).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates unique secrets', () => {
    const codes = new Set(Array.from({ length: 200 }, generateDeviceCode));
    expect(codes.size).toBe(200);
  });

  it('hashes deterministically with sha256 and never returns the input', () => {
    const code = 'abc123';
    const hash = hashDeviceCode(code);
    expect(hash).toBe(hashDeviceCode(code));
    expect(hash).not.toBe(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('user code', () => {
  it('uses only the unambiguous alphabet and the configured length', () => {
    for (let i = 0; i < 100; i++) {
      const code = generateUserCode();
      expect(code).toHaveLength(USER_CODE_LENGTH);
      for (const ch of code) expect(USER_CODE_ALPHABET).toContain(ch);
    }
  });

  it('excludes visually ambiguous characters', () => {
    for (const bad of ['0', '1', 'I', 'O', 'U']) {
      expect(USER_CODE_ALPHABET).not.toContain(bad);
    }
  });

  it('formats compact codes as two dash-separated halves', () => {
    expect(formatUserCode('BCDFGHJK')).toBe('BCDF-GHJK');
  });

  it('normalizes case, separators, and whitespace to the compact form', () => {
    expect(normalizeUserCode('  bcdf-ghjk ')).toBe('BCDFGHJK');
    expect(normalizeUserCode('bc df gh jk')).toBe('BCDFGHJK');
  });

  it('round-trips: a generated code normalizes back from its formatted form', () => {
    const code = generateUserCode();
    expect(normalizeUserCode(formatUserCode(code))).toBe(code);
  });
});

describe('parseScopes', () => {
  it('splits on spaces and commas and drops empties', () => {
    expect(parseScopes('inference, billing  read')).toEqual(['inference', 'billing', 'read']);
  });
  it('returns [] for empty/missing scope', () => {
    expect(parseScopes('')).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe('normalizeDeviceScope', () => {
  it('defaults omitted or blank requests to inference-only', () => {
    expect(normalizeDeviceScope(undefined)).toEqual({ ok: true, scope: 'inference' });
    expect(normalizeDeviceScope(null)).toEqual({ ok: true, scope: 'inference' });
    expect(normalizeDeviceScope('   ')).toEqual({ ok: true, scope: 'inference' });
  });

  it('accepts supported capabilities and returns stable canonical order', () => {
    expect(normalizeDeviceScope('read')).toEqual({ ok: true, scope: 'read' });
    expect(normalizeDeviceScope('read,inference,read')).toEqual({
      ok: true,
      scope: 'inference read',
    });
  });

  it('rejects unknown, mixed-unknown, separators-only, and oversized values', () => {
    expect(normalizeDeviceScope('billing')).toEqual({ ok: false });
    expect(normalizeDeviceScope('inference billing')).toEqual({ ok: false });
    expect(normalizeDeviceScope(',,,')).toEqual({ ok: false });
    expect(normalizeDeviceScope('x'.repeat(DEVICE_SCOPE_MAX_LENGTH + 1))).toEqual({ ok: false });
    expect(normalizeDeviceScope(' '.repeat(DEVICE_SCOPE_MAX_LENGTH + 1))).toEqual({ ok: false });
  });
});

describe('expiry', () => {
  it('treats a past timestamp as expired and a future one as live', () => {
    const now = new Date('2026-05-30T12:00:00Z');
    expect(isExpired(new Date('2026-05-30T11:59:59Z'), now)).toBe(true);
    expect(isExpired(new Date('2026-05-30T12:00:01Z'), now)).toBe(false);
  });

  it('treats the exact expiry instant as expired (inclusive)', () => {
    const t = new Date('2026-05-30T12:00:00Z');
    expect(isExpired(t, t)).toBe(true);
  });
});

describe('poll cadence (slow_down)', () => {
  const now = new Date('2026-05-30T12:00:10Z');

  it('never flags a first poll', () => {
    expect(isPolledTooSoon(null, DEFAULT_POLL_INTERVAL_SECONDS, now)).toBe(false);
    expect(isPolledTooSoon(undefined, DEFAULT_POLL_INTERVAL_SECONDS, now)).toBe(false);
  });

  it('flags a poll inside the interval', () => {
    const last = new Date('2026-05-30T12:00:07Z'); // 3s ago, interval 5s
    expect(isPolledTooSoon(last, DEFAULT_POLL_INTERVAL_SECONDS, now)).toBe(true);
  });

  it('allows a poll at or beyond the interval', () => {
    const last = new Date('2026-05-30T12:00:05Z'); // 5s ago, interval 5s
    expect(isPolledTooSoon(last, DEFAULT_POLL_INTERVAL_SECONDS, now)).toBe(false);
  });
});

describe('config', () => {
  it('defaults the device-code TTL to 10 minutes and interval to 5s', () => {
    expect(DEVICE_CODE_TTL_SECONDS).toBe(600);
    expect(DEFAULT_POLL_INTERVAL_SECONDS).toBe(5);
  });

  it('defaults minted-key TTL to 30 days, honoring a valid override', () => {
    const prev = process.env.OAUTH_DEVICE_KEY_TTL_HOURS;
    try {
      delete process.env.OAUTH_DEVICE_KEY_TTL_HOURS;
      expect(mintedKeyTtlHours()).toBe(720);
      process.env.OAUTH_DEVICE_KEY_TTL_HOURS = '24';
      expect(mintedKeyTtlHours()).toBe(24);
      process.env.OAUTH_DEVICE_KEY_TTL_HOURS = 'garbage';
      expect(mintedKeyTtlHours()).toBe(720);
      process.env.OAUTH_DEVICE_KEY_TTL_HOURS = '-5';
      expect(mintedKeyTtlHours()).toBe(720);
    } finally {
      if (prev === undefined) delete process.env.OAUTH_DEVICE_KEY_TTL_HOURS;
      else process.env.OAUTH_DEVICE_KEY_TTL_HOURS = prev;
    }
  });
});
