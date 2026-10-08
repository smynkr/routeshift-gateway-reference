import { describe, expect, it } from 'vitest';
import { maskSecret, redact } from '../src/redact';
import { deepGet, deepSet, deepUnset } from '../src/json-file';

describe('maskSecret', () => {
  it('keeps the non-secret prefix and masks the random tail', () => {
    const masked = maskSecret('sk-proxy-live_team_abc123def456');
    expect(masked).toBe('sk-proxy-live_team_••••••••');
    expect(masked).not.toContain('abc123def456');
  });

  it('returns empty for empty input', () => {
    expect(maskSecret('')).toBe('');
  });

  it('stays safe even if the random tail contains an underscore', () => {
    // Caps at the first two segments, so a tail with '_' cannot leak.
    const masked = maskSecret('sk-proxy-live_team_SEG_RET');
    expect(masked).toBe('sk-proxy-live_team_••••••••');
    expect(masked).not.toContain('SEG');
    expect(masked).not.toContain('RET');
  });
});

describe('redact', () => {
  it('replaces every occurrence of the secret', () => {
    const secret = 'sk-proxy-live_t_SECRETTAIL';
    const text = `apiKey=${secret} again=${secret}`;
    const out = redact(text, secret);
    expect(out).not.toContain('SECRETTAIL');
    expect(out.match(/••••••••/g)).toHaveLength(2);
  });

  it('is a no-op when no secret is given', () => {
    expect(redact('hello', '')).toBe('hello');
  });
});

describe('deepSet / deepGet / deepUnset', () => {
  it('sets a nested path without mutating the input', () => {
    const before = { a: { b: 1 } };
    const after = deepSet(before, 'a.c', 2);
    expect(deepGet(after, 'a.c')).toBe(2);
    expect(deepGet(after, 'a.b')).toBe(1);
    expect(before).toEqual({ a: { b: 1 } }); // unchanged
  });

  it('unset removes the leaf and prunes empty parents', () => {
    const before = { env: { ANTHROPIC_AUTH_TOKEN: 'x' }, other: true };
    const after = deepUnset(before, 'env.ANTHROPIC_AUTH_TOKEN');
    expect(after).toEqual({ other: true }); // empty `env` pruned
  });

  it('unset preserves sibling keys under a shared parent', () => {
    const before = { env: { A: '1', B: '2' } };
    const after = deepUnset(before, 'env.A');
    expect(after).toEqual({ env: { B: '2' } });
  });

  it('refuses prototype-polluting path segments (deepSet)', () => {
    expect(() => deepSet({}, '__proto__.polluted', true)).toThrow(/unsafe config path/);
    expect(() => deepSet({}, 'a.constructor.x', 1)).toThrow(/unsafe config path/);
    expect(() => deepSet({}, 'prototype.x', 1)).toThrow(/unsafe config path/);
    // The global prototype must be untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses prototype-polluting path segments (deepUnset)', () => {
    expect(() => deepUnset({}, '__proto__.polluted')).toThrow(/unsafe config path/);
  });
});
