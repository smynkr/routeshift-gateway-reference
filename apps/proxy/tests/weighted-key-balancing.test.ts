// LAY-319: weighted round-robin across N enabled keys per (team, provider).
//
// Strategy: every call increments a per-bucket cursor; we bucket the cursor
// modulo total weight and walk weights to find the slot. Over enough calls
// the distribution lands at weight ratios. We also verify single-key
// behavior is unchanged (no balancing) and disabled keys are filtered out.

import { describe, expect, it, beforeEach, vi } from 'vitest';

const mockQuery = vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  encryptProviderKey,
  getDecryptedProviderKey,
  invalidateKeyCache,
} from '../src/billing/provider-key-crypto.js';

// LAY-327: loadBucket now fans out to two parallel queries (keys + strategy).
// Default the strategy query to "no row" (→ weighted_round_robin fallback).
function mockBucket(keyRows: unknown[]) {
  mockQuery.mockImplementationOnce(async () => ({ rows: keyRows }));
  mockQuery.mockImplementationOnce(async () => ({ rows: [] }));
}

beforeEach(() => {
  process.env.PROVIDER_KEY_SECRET ??= 'a'.repeat(64);
  mockQuery.mockReset();
  invalidateKeyCache('team_lay319', 'openai');
});

describe('LAY-319 weighted round-robin', () => {
  it('single enabled key returns that key on every call', async () => {
    const enc = await encryptProviderKey('sk-only');
    mockBucket([{ label: 'default', weight: 1, encrypted_key: enc, metadata: {} }]);
    const a = await getDecryptedProviderKey('team_lay319', 'openai');
    const b = await getDecryptedProviderKey('team_lay319', 'openai');
    expect(a?.key).toBe('sk-only');
    expect(b?.key).toBe('sk-only');
    // The second call should hit the cache; only the initial keys+strategy queries.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('two keys at weight 3 and 1 split traffic ~75/25', async () => {
    const heavyEnc = await encryptProviderKey('sk-heavy');
    const lightEnc = await encryptProviderKey('sk-light');
    mockBucket([
      { label: 'primary', weight: 3, encrypted_key: heavyEnc, metadata: {} },
      { label: 'secondary', weight: 1, encrypted_key: lightEnc, metadata: {} },
    ]);
    const counts = { heavy: 0, light: 0 };
    for (let i = 0; i < 1000; i++) {
      const r = await getDecryptedProviderKey('team_lay319', 'openai');
      if (r?.key === 'sk-heavy') counts.heavy++;
      else if (r?.key === 'sk-light') counts.light++;
    }
    // Both keys should be sampled.
    expect(counts.heavy).toBeGreaterThan(700);
    expect(counts.light).toBeGreaterThan(200);
    expect(counts.heavy + counts.light).toBe(1000);
  });

  it('disabling the high-weight key sends 100% of traffic to the other', async () => {
    // Initial bucket: only the light key is enabled (heavy was disabled).
    const lightEnc = await encryptProviderKey('sk-light');
    mockBucket([
      { label: 'secondary', weight: 1, encrypted_key: lightEnc, metadata: {} },
    ]);
    for (let i = 0; i < 50; i++) {
      const r = await getDecryptedProviderKey('team_lay319', 'openai');
      expect(r?.key).toBe('sk-light');
    }
  });

  it('returns the label of the selected key on the config object', async () => {
    const enc = await encryptProviderKey('sk-labeled');
    mockBucket([{ label: 'primary', weight: 1, encrypted_key: enc, metadata: {} }]);
    const r = await getDecryptedProviderKey('team_lay319', 'openai');
    expect(r?.label).toBe('primary');
  });
});
