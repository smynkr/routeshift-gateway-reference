import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const queryMock = vi.fn();
vi.mock('../src/db/pool.js', () => ({ getPool: () => ({ query: queryMock }) }));
vi.mock('../src/billing/rate-limit-cooldown.js', () => ({ getCooledLabels: vi.fn(() => new Set()) }));
vi.mock('../src/billing/key-stats.js', () => ({
  LATENCY_MIN_SAMPLES: 3,
  getInFlight: vi.fn(() => 0),
  getLatencyStats: vi.fn(() => null),
}));

import {
  encryptWithDek,
  encodeV3Envelope,
  buildAad,
  type KeyEncryptionProvider,
} from '@routeshift/shared/provider-key-envelope';
import { setKekAdapter, decryptProviderKeyV3, clearDekCache } from '../src/billing/provider-key-crypto.js';

const TEST_DEK = randomBytes(32);

const fakeAdapter: KeyEncryptionProvider = {
  async generateDataKey({ keyReference, context }) {
    const dek = randomBytes(32);
    return { plaintextDek: dek, wrappedDek: dek };
  },
  async unwrapDataKey({ keyReference, wrappedDek, context }) {
    return wrappedDek;
  },
};

const TEST_AAD_CTX = {
  context_version: 1,
  team_id: 'team-v3',
  secret_class: 'provider_key',
  provider: 'openai',
  label: 'default',
  dek_version: 1,
};

function makeV3Payload(plaintext: string, dek: Uint8Array = TEST_DEK): string {
  const aad = buildAad(TEST_AAD_CTX);
  const envelope = encryptWithDek(Buffer.from(plaintext, 'utf8'), dek, aad);
  return encodeV3Envelope(envelope);
}

describe('RSH-88 Phase 1 dual-read', () => {
  beforeEach(() => {
    queryMock.mockReset();
    setKekAdapter(null);
    clearDekCache();
  });

  afterEach(() => {
    setKekAdapter(null);
  });

  describe('decryptProviderKeyV3', () => {
    it('round-trips a v3-encrypted provider key', async () => {
      setKekAdapter(fakeAdapter);
      queryMock.mockResolvedValue({
        rows: [{ wrapped_dek: TEST_DEK, kek_key_ref: 'test-kek', context_version: 1 }],
      });

      const payload = makeV3Payload('sk-test-v3-key-12345');
      const result = await decryptProviderKeyV3(payload, 'team-v3', 'openai', 'default', 1);
      expect(result).toBe('sk-test-v3-key-12345');
    });

    it('fails closed when no KEK adapter is configured', async () => {
      setKekAdapter(null);
      const payload = makeV3Payload('sk-test');
      await expect(decryptProviderKeyV3(payload, 'team-v3', 'openai', 'default', 1))
        .rejects.toThrow('No KEK adapter configured');
    });

    it('fails closed when no DEK row exists', async () => {
      setKekAdapter(fakeAdapter);
      queryMock.mockResolvedValue({ rows: [] });
      const payload = makeV3Payload('sk-test');
      await expect(decryptProviderKeyV3(payload, 'team-v3', 'openai', 'default', 1))
        .rejects.toThrow('No team DEK found');
    });

    it('fails closed on AAD mismatch (wrong team)', async () => {
      setKekAdapter(fakeAdapter);
      queryMock.mockResolvedValue({
        rows: [{ wrapped_dek: TEST_DEK, kek_key_ref: 'test-kek', context_version: 1 }],
      });
      const payload = makeV3Payload('sk-test');
      await expect(decryptProviderKeyV3(payload, 'team-WRONG', 'openai', 'default', 1))
        .rejects.toThrow();
    });

    it('fails closed on AAD mismatch (wrong provider)', async () => {
      setKekAdapter(fakeAdapter);
      queryMock.mockResolvedValue({
        rows: [{ wrapped_dek: TEST_DEK, kek_key_ref: 'test-kek', context_version: 1 }],
      });
      const payload = makeV3Payload('sk-test');
      await expect(decryptProviderKeyV3(payload, 'team-v3', 'anthropic', 'default', 1))
        .rejects.toThrow();
    });

    it('caches the DEK across calls', async () => {
      setKekAdapter(fakeAdapter);
      queryMock.mockResolvedValue({
        rows: [{ wrapped_dek: TEST_DEK, kek_key_ref: 'test-kek', context_version: 1 }],
      });

      const payload = makeV3Payload('sk-test');
      await decryptProviderKeyV3(payload, 'team-v3', 'openai', 'default', 1);
      await decryptProviderKeyV3(payload, 'team-v3', 'openai', 'default', 1);

      const dekQueries = queryMock.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('team_data_keys'),
      );
      expect(dekQueries).toHaveLength(1);
    });

    it('rejects malformed v3 payloads', async () => {
      setKekAdapter(fakeAdapter);
      await expect(decryptProviderKeyV3('not-json', 'team-v3', 'openai', 'default', 1))
        .rejects.toThrow();
    });
  });
});
