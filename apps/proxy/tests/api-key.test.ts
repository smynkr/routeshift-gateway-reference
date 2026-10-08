import { describe, it, expect } from 'vitest';
import { hashApiKey, generateApiKey } from '../src/auth/api-key.js';

describe('api-key', () => {
  it('generates key with correct format', () => {
    const { key, hash, prefix } = generateApiKey('team_abc', 'live');
    expect(key).toMatch(/^sk-proxy-live_team_[a-f0-9]{32}$/);
    expect(prefix).toBe('sk-proxy-live_team');
    expect(hash).toHaveLength(64);
  });

  it('hashes consistently', () => {
    const hash1 = hashApiKey('sk-proxy-live_test_abc123');
    const hash2 = hashApiKey('sk-proxy-live_test_abc123');
    expect(hash1).toBe(hash2);
  });

  it('different keys produce different hashes', () => {
    const hash1 = hashApiKey('key1');
    const hash2 = hashApiKey('key2');
    expect(hash1).not.toBe(hash2);
  });

  it('generates test environment keys', () => {
    const { key } = generateApiKey('team_xyz', 'test');
    expect(key).toMatch(/^sk-proxy-test_team_/);
  });
});
