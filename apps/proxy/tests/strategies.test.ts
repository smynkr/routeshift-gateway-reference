// LAY-327: latency-based + least-busy selection strategies.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  encryptProviderKey,
  getDecryptedProviderKey,
  invalidateKeyCache,
} from '../src/billing/provider-key-crypto.js';
import {
  _resetKeyStats,
  decrementInFlight,
  incrementInFlight,
  recordLatency,
} from '../src/billing/key-stats.js';

function mockBucketWithStrategy(
  keyRows: unknown[],
  strategy: 'weighted_round_robin' | 'latency_based' | 'least_busy',
) {
  mockQuery.mockImplementationOnce(async () => ({ rows: keyRows }));
  mockQuery.mockImplementationOnce(async () => ({ rows: [{ strategy }] }));
}

beforeEach(() => {
  process.env.PROVIDER_KEY_SECRET ??= 'a'.repeat(64);
  mockQuery.mockReset();
  _resetKeyStats();
  invalidateKeyCache('team_327', 'openai');
});

afterEach(() => {
  invalidateKeyCache('team_327', 'openai');
});

describe('latency_based strategy', () => {
  it('routes 100% of requests to the faster key once both have ≥10 samples', async () => {
    const fastEnc = await encryptProviderKey('sk-fast');
    const slowEnc = await encryptProviderKey('sk-slow');
    mockBucketWithStrategy(
      [
        { label: 'fast', weight: 1, encrypted_key: fastEnc, metadata: {} },
        { label: 'slow', weight: 1, encrypted_key: slowEnc, metadata: {} },
      ],
      'latency_based',
    );

    // Prime the trackers with sufficient samples on each.
    for (let i = 0; i < 12; i++) recordLatency('team_327', 'openai', 'fast', 100);
    for (let i = 0; i < 12; i++) recordLatency('team_327', 'openai', 'slow', 500);

    const counts = { fast: 0, slow: 0 };
    for (let i = 0; i < 50; i++) {
      const r = await getDecryptedProviderKey('team_327', 'openai');
      if (r?.label === 'fast') counts.fast++;
      else if (r?.label === 'slow') counts.slow++;
    }
    expect(counts.fast).toBe(50);
    expect(counts.slow).toBe(0);
  });

  it('falls back to weighted RR when one or more keys have <10 samples', async () => {
    const aEnc = await encryptProviderKey('sk-a');
    const bEnc = await encryptProviderKey('sk-b');
    mockBucketWithStrategy(
      [
        { label: 'a', weight: 1, encrypted_key: aEnc, metadata: {} },
        { label: 'b', weight: 1, encrypted_key: bEnc, metadata: {} },
      ],
      'latency_based',
    );

    // 'a' has plenty of samples; 'b' has only 5 → cold-start fallback.
    for (let i = 0; i < 30; i++) recordLatency('team_327', 'openai', 'a', 50);
    for (let i = 0; i < 5; i++) recordLatency('team_327', 'openai', 'b', 1000);

    const counts: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 200; i++) {
      const r = await getDecryptedProviderKey('team_327', 'openai');
      counts[r!.label!]++;
    }
    // WRR with equal weights → roughly 50/50. Both keys must see traffic.
    expect(counts.a).toBeGreaterThan(50);
    expect(counts.b).toBeGreaterThan(50);
  });
});

describe('least_busy strategy', () => {
  it('picks the key with the lowest in-flight counter', async () => {
    const aEnc = await encryptProviderKey('sk-a');
    const bEnc = await encryptProviderKey('sk-b');
    mockBucketWithStrategy(
      [
        { label: 'a', weight: 1, encrypted_key: aEnc, metadata: {} },
        { label: 'b', weight: 1, encrypted_key: bEnc, metadata: {} },
      ],
      'least_busy',
    );

    // Pretend 5 requests are mid-flight on 'a'; 'b' is idle.
    for (let i = 0; i < 5; i++) incrementInFlight('team_327', 'openai', 'a');

    const r = await getDecryptedProviderKey('team_327', 'openai');
    expect(r?.label).toBe('b');

    // Cleanup so other tests start clean.
    for (let i = 0; i < 5; i++) decrementInFlight('team_327', 'openai', 'a');
  });

  it('breaks ties by preferring the heavier-weighted key', async () => {
    const lightEnc = await encryptProviderKey('sk-light');
    const heavyEnc = await encryptProviderKey('sk-heavy');
    mockBucketWithStrategy(
      [
        { label: 'light', weight: 1, encrypted_key: lightEnc, metadata: {} },
        { label: 'heavy', weight: 5, encrypted_key: heavyEnc, metadata: {} },
      ],
      'least_busy',
    );

    // No in-flight on either side → tie → weight 5 wins.
    const r = await getDecryptedProviderKey('team_327', 'openai');
    expect(r?.label).toBe('heavy');
  });
});
