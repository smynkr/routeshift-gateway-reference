import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';

const { mockKmsSend } = vi.hoisted(() => ({ mockKmsSend: vi.fn() }));

vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class { send = mockKmsSend; },
  GenerateDataKeyCommand: class { constructor(readonly input: unknown) {} },
  DecryptCommand: class { constructor(readonly input: unknown) {} },
}));

// ---------------------------------------------------------------------------
// Mock DB pool
// ---------------------------------------------------------------------------
const mockQuery = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import {
  encryptProviderKey,
  decryptProviderKey,
  getDecryptedProviderKey,
  hasEnabledProviderKey,
  getUsableProviderKeyLabels,
  invalidateKeyCache,
  _resetSecretCache,
} from '../src/billing/provider-key-crypto.js';
import {
  _resetCooldowns,
  markCooldown,
} from '../src/billing/rate-limit-cooldown.js';

const originalKmsKeyId = process.env.KMS_KEY_ID;
const STRICT_V1_IV = Buffer.alloc(12, 5).toString('base64');
const STRICT_V1_CIPHERTEXT = Buffer.from('x').toString('base64');
const STRICT_V1_AUTH_TAG = Buffer.alloc(16, 6).toString('base64');
const STRICT_V1_ENVELOPE = [STRICT_V1_IV, STRICT_V1_CIPHERTEXT, STRICT_V1_AUTH_TAG].join(':');

beforeAll(() => {
  process.env.PROVIDER_KEY_SECRET = 'a'.repeat(64);
  // Remove previous secret so it doesn't interfere
  delete process.env.PROVIDER_KEY_SECRET_PREVIOUS;
  delete process.env.KMS_KEY_ID;
});

afterAll(() => {
  if (originalKmsKeyId === undefined) delete process.env.KMS_KEY_ID;
  else process.env.KMS_KEY_ID = originalKmsKeyId;
});

// LAY-327 made loadBucket fan out to two parallel queries: keys + strategy.
// Default the strategy query to "no row" (→ falls back to weighted_round_robin).
// Tests that need a different strategy override per-call.
function mockKeyRows(rows: unknown[]) {
  mockQuery.mockImplementationOnce(async () => ({ rows }));
  mockQuery.mockImplementationOnce(async () => ({ rows: [] }));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockKmsSend.mockReset();
  _resetSecretCache();
  _resetCooldowns();
  process.env.PROVIDER_KEY_SECRET = 'a'.repeat(64);
  delete process.env.PROVIDER_KEY_SECRET_PREVIOUS;
  delete process.env.KMS_KEY_ID;
  // Clear the internal cache between tests
  invalidateKeyCache('team_1', 'openai');
  invalidateKeyCache('team_1', 'anthropic');
  invalidateKeyCache('team_2', 'openai');
});

// ---------------------------------------------------------------------------
// encryptProviderKey
// ---------------------------------------------------------------------------
describe('encryptProviderKey', () => {
  it('', async () => {
    const encrypted = await encryptProviderKey('sk-test-key-12345');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    // Each part should be valid base64
    for (const part of parts) {
      expect(() => Buffer.from(part, 'base64')).not.toThrow();
      expect(part.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// decryptProviderKey
// ---------------------------------------------------------------------------
describe('decryptProviderKey', () => {
  it('', async () => {
    const original = 'sk-my-secret-provider-key-abc123';
    const encrypted = await encryptProviderKey(original);
    const decrypted = await decryptProviderKey(encrypted);
    expect(decrypted).toBe(original);
  });

  it('decrypts a v2 envelope with a KMS ARN key ID', async () => {
    const dek = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(12, 3);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    const ciphertext = Buffer.concat([cipher.update('sk-kms-arn-key', 'utf8'), cipher.final()]);
    const wrappedDek = Buffer.from('wrapped-dek');
    const payload = [
      'v2',
      'arn:aws:kms:us-east-1:123456789012:key/abc',
      wrappedDek.toString('base64'),
      iv.toString('base64'),
      ciphertext.toString('base64'),
      cipher.getAuthTag().toString('base64'),
    ].join(':');
    mockKmsSend.mockResolvedValueOnce({ Plaintext: Buffer.from(dek) });

    await expect(decryptProviderKey(payload)).resolves.toBe('sk-kms-arn-key');
    const command = mockKmsSend.mock.calls[0]?.[0] as { input: { CiphertextBlob: Uint8Array } };
    expect(Buffer.from(command.input.CiphertextBlob)).toEqual(wrappedDek);
  });

  it.each([
    ['whitespace in v1', ` ${STRICT_V1_ENVELOPE}`],
    ['non-canonical v1 base64', STRICT_V1_ENVELOPE.replace(STRICT_V1_CIPHERTEXT, 'eA')],
    ['oversized v1', `${STRICT_V1_IV}:${'A'.repeat(65_536)}:${STRICT_V1_AUTH_TAG}`],
    ['v3 envelope without team context', '{"v":3,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"eA","tag":"AAAAAAAAAAAAAAAAAAAAAA"}'],
    ['classification-only aws-kms envelope', 'aws-kms://key-id:ciphertext:dek'],
  ])('fails closed for %s', async (_description, payload) => {
    await expect(decryptProviderKey(payload)).rejects.toThrow();
  });

  it('throws on bad format (not 3 parts)', async () => {
    await expect(decryptProviderKey('onlytwoparts:here')).rejects.toThrow(
      'Invalid encrypted key format',
    );
    await expect(decryptProviderKey('single')).rejects.toThrow(
      'Invalid encrypted key format',
    );
    await expect(decryptProviderKey('a:b:c:d')).rejects.toThrow(
      'Invalid encrypted key format',
    );
  });

  it('', async () => {
    // Encrypt with current secret
    const encrypted = await encryptProviderKey('sk-test');

    // Change secret and reset cache so new secret is picked up
    const origSecret = process.env.PROVIDER_KEY_SECRET;
    process.env.PROVIDER_KEY_SECRET = 'b'.repeat(64);
    delete process.env.PROVIDER_KEY_SECRET_PREVIOUS;
    _resetSecretCache();

    await expect(decryptProviderKey(encrypted, false)).rejects.toThrow('Failed to decrypt');

    // Restore
    process.env.PROVIDER_KEY_SECRET = origSecret!;
    _resetSecretCache();
  });

  it('', async () => {
    process.env.PROVIDER_KEY_SECRET = 'a'.repeat(64);
    _resetSecretCache();
    const encrypted = await encryptProviderKey('sk-rotated-key');

    process.env.PROVIDER_KEY_SECRET = 'b'.repeat(64);
    process.env.PROVIDER_KEY_SECRET_PREVIOUS = 'a'.repeat(64);
    _resetSecretCache();

    const decrypted = await decryptProviderKey(encrypted, true);
    expect(decrypted).toBe('sk-rotated-key');
  });

  it('', async () => {
    delete process.env.PROVIDER_KEY_SECRET;
    _resetSecretCache();

    await expect(encryptProviderKey('sk-test')).rejects.toThrow(
      'PROVIDER_KEY_SECRET environment variable is not set',
    );

    process.env.PROVIDER_KEY_SECRET = 'a'.repeat(64);
    _resetSecretCache();
  });

  it('', async () => {
    const encrypted = await encryptProviderKey('sk-test');
    process.env.PROVIDER_KEY_SECRET = 'b'.repeat(64);
    process.env.PROVIDER_KEY_SECRET_PREVIOUS = '1234';
    _resetSecretCache();

    await expect(decryptProviderKey(encrypted, true)).rejects.toThrow(
      'PROVIDER_KEY_SECRET_PREVIOUS must be a 64-char hex string',
    );

    process.env.PROVIDER_KEY_SECRET = 'a'.repeat(64);
    delete process.env.PROVIDER_KEY_SECRET_PREVIOUS;
    _resetSecretCache();
  });
});

// ---------------------------------------------------------------------------
// getDecryptedProviderKey
// ---------------------------------------------------------------------------
async function row(label: string, plaintext: string, weight = 1) {
  return {
    label,
    weight,
    encrypted_key: await encryptProviderKey(plaintext),
    metadata: {},
  };
}

describe('getDecryptedProviderKey', () => {
  it('returns cached value on cache hit (no DB query)', async () => {
    mockKeyRows([await row('default', 'sk-cached-key')]);

    const first = await getDecryptedProviderKey('team_1', 'openai');
    expect(first?.key).toBe('sk-cached-key');
    expect(mockQuery).toHaveBeenCalledTimes(2); // keys + strategy

    // Second call: cache hit, no DB query
    const second = await getDecryptedProviderKey('team_1', 'openai');
    expect(second?.key).toBe('sk-cached-key');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('queries DB on cache miss and caches the result', async () => {
    mockKeyRows([await row('default', 'sk-fresh-key')]);

    const result = await getDecryptedProviderKey('team_2', 'openai');
    expect(result?.key).toBe('sk-fresh-key');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown non-null encryption scheme', async () => {
    mockKeyRows([{ ...(await row('default', 'sk-key')), encryption_scheme: 'future-v4' }]);

    await expect(getDecryptedProviderKey('team_1', 'openai')).rejects.toThrow(
      'Unsupported provider-key encryption scheme',
    );
  });

  it('rejects a declared v1 scheme for a v2 payload', async () => {
    mockKeyRows([{
      label: 'default',
      weight: 1,
      encrypted_key: [
        'v2',
        'arn:aws:kms:us-east-1:123456789012:key/abc',
        Buffer.from('wrapped-dek').toString('base64'),
        Buffer.alloc(12, 1).toString('base64'),
        Buffer.from('ciphertext').toString('base64'),
        Buffer.alloc(16, 2).toString('base64'),
      ].join(':'),
      encryption_scheme: 'local-v1',
      metadata: {},
    }]);

    await expect(getDecryptedProviderKey('team_1', 'openai')).rejects.toThrow(
      'does not match payload',
    );
  });

  it('returns null when no DB row exists', async () => {
    mockKeyRows([]);

    const result = await getDecryptedProviderKey('team_1', 'anthropic');
    expect(result).toBeNull();
  });

  it('caches null results to avoid repeated DB misses', async () => {
    mockKeyRows([]);

    const first = await getDecryptedProviderKey('team_2', 'anthropic');
    const second = await getDecryptedProviderKey('team_2', 'anthropic');

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('supports team-wide cache invalidation across providers', async () => {
    mockKeyRows([await row('default', 'sk-openai')]);
    mockKeyRows([await row('default', 'sk-anthropic')]);
    mockKeyRows([await row('default', 'sk-openai')]);
    mockKeyRows([await row('default', 'sk-anthropic')]);

    expect((await getDecryptedProviderKey('team_1', 'openai'))?.key).toBe('sk-openai');
    expect((await getDecryptedProviderKey('team_1', 'anthropic'))?.key).toBe('sk-anthropic');
    expect(mockQuery).toHaveBeenCalledTimes(4);

    invalidateKeyCache('team_1');

    expect((await getDecryptedProviderKey('team_1', 'openai'))?.key).toBe('sk-openai');
    expect((await getDecryptedProviderKey('team_1', 'anthropic'))?.key).toBe('sk-anthropic');
    expect(mockQuery).toHaveBeenCalledTimes(8);
  });

  // ---------------------------------------------------------------------
  // LAY-320: rate-limit cooldown integration
  // ---------------------------------------------------------------------
  it('skips a cooled credential when an alternate is available', async () => {
    mockKeyRows([await row('primary', 'sk-primary'), await row('backup', 'sk-backup')]);

    markCooldown('team_1', 'openai', 'primary');
    const result = await getDecryptedProviderKey('team_1', 'openai');
    expect(result?.key).toBe('sk-backup');
    expect(result?.label).toBe('backup');
    expect(result?.selected_after_cooldown_skip).toBe(true);
  });

  it('falls through to a cooled key when ALL keys in the bucket are cooled', async () => {
    mockKeyRows([await row('primary', 'sk-primary'), await row('backup', 'sk-backup')]);

    markCooldown('team_1', 'openai', 'primary');
    markCooldown('team_1', 'openai', 'backup');

    const result = await getDecryptedProviderKey('team_1', 'openai');
    // Whichever key gets returned, it must be one of the two and the skip
    // flag must be unset — we didn't actually filter anything out.
    expect(['sk-primary', 'sk-backup']).toContain(result?.key);
    expect(result?.selected_after_cooldown_skip).toBeUndefined();
  });

  it('does not flip the skip flag when no keys are cooled', async () => {
    mockKeyRows([await row('primary', 'sk-primary'), await row('backup', 'sk-backup')]);

    const result = await getDecryptedProviderKey('team_1', 'openai');
    expect(result?.selected_after_cooldown_skip).toBeUndefined();
  });
});

describe('hasEnabledProviderKey', () => {
  it('rejects an enabled row whose decrypted credential is only whitespace', async () => {
    mockKeyRows([await row('blank', '   ')]);

    await expect(hasEnabledProviderKey('team_1', 'openai')).resolves.toBe(false);

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('accepts an enabled row with a usable decrypted credential', async () => {
    mockKeyRows([await row('primary', '  sk-provider-key  ')]);

    await expect(hasEnabledProviderKey('team_1', 'openai')).resolves.toBe(true);

    expect((await getDecryptedProviderKey('team_1', 'openai'))?.key).toBe('sk-provider-key');
    await expect(getUsableProviderKeyLabels('team_1', 'openai')).resolves.toEqual(['primary']);
  });
});
