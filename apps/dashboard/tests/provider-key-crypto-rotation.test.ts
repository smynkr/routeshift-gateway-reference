import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv } from 'node:crypto';

const { mockKmsSend } = vi.hoisted(() => ({ mockKmsSend: vi.fn() }));

vi.mock('@aws-sdk/client-kms', () => ({
  KMSClient: class { send = mockKmsSend; },
  GenerateDataKeyCommand: class { constructor(readonly input: unknown) {} },
  DecryptCommand: class { constructor(readonly input: unknown) {} },
}));

import { decryptProviderKey, encryptProviderKey } from '@/lib/crypto';

const CURRENT_SECRET = '11'.repeat(32);
const PREVIOUS_SECRET = '22'.repeat(32);

const originalCurrentSecret = process.env.PROVIDER_KEY_SECRET;
const originalPreviousSecret = process.env.PROVIDER_KEY_SECRET_PREVIOUS;
const originalKmsKeyId = process.env.KMS_KEY_ID;
const STRICT_V1_IV = Buffer.alloc(12, 5).toString('base64');
const STRICT_V1_CIPHERTEXT = Buffer.from('x').toString('base64');
const STRICT_V1_AUTH_TAG = Buffer.alloc(16, 6).toString('base64');
const STRICT_V1_ENVELOPE = [STRICT_V1_IV, STRICT_V1_CIPHERTEXT, STRICT_V1_AUTH_TAG].join(':');

afterEach(() => {
  mockKmsSend.mockReset();

  if (originalCurrentSecret === undefined) delete process.env.PROVIDER_KEY_SECRET;
  else process.env.PROVIDER_KEY_SECRET = originalCurrentSecret;

  if (originalPreviousSecret === undefined) delete process.env.PROVIDER_KEY_SECRET_PREVIOUS;
  else process.env.PROVIDER_KEY_SECRET_PREVIOUS = originalPreviousSecret;

  if (originalKmsKeyId === undefined) delete process.env.KMS_KEY_ID;
  else process.env.KMS_KEY_ID = originalKmsKeyId;
});

describe('provider key secret rotation', () => {
  it('decrypts a V1 key with the previous secret during the rotation window', async () => {
    delete process.env.KMS_KEY_ID;
    delete process.env.PROVIDER_KEY_SECRET_PREVIOUS;
    process.env.PROVIDER_KEY_SECRET = PREVIOUS_SECRET;
    const encrypted = await encryptProviderKey('sk-rotated-provider-key');

    process.env.PROVIDER_KEY_SECRET = CURRENT_SECRET;
    process.env.PROVIDER_KEY_SECRET_PREVIOUS = PREVIOUS_SECRET;

    await expect(decryptProviderKey(encrypted)).resolves.toBe('sk-rotated-provider-key');
  });

  it('fails closed when neither configured secret can decrypt the key', async () => {
    delete process.env.KMS_KEY_ID;
    delete process.env.PROVIDER_KEY_SECRET_PREVIOUS;
    process.env.PROVIDER_KEY_SECRET = PREVIOUS_SECRET;
    const encrypted = await encryptProviderKey('sk-unavailable-provider-key');

    process.env.PROVIDER_KEY_SECRET = CURRENT_SECRET;

    await expect(decryptProviderKey(encrypted)).rejects.toThrow(
      'Failed to decrypt provider key with any available secret',
    );
  });

  it('decrypts a v2 envelope with a KMS ARN key ID', async () => {
    const dek = Buffer.alloc(32, 7);
    const iv = Buffer.alloc(12, 3);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ciphertext = Buffer.concat([cipher.update('sk-dashboard-kms-arn', 'utf8'), cipher.final()]);
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

    await expect(decryptProviderKey(payload)).resolves.toBe('sk-dashboard-kms-arn');
    const command = mockKmsSend.mock.calls[0]?.[0] as { input: { CiphertextBlob: Uint8Array } };
    expect(Buffer.from(command.input.CiphertextBlob)).toEqual(wrappedDek);
  });

  it.each([
    ['whitespace in v1', ` ${STRICT_V1_ENVELOPE}`],
    ['non-canonical v1 base64', STRICT_V1_ENVELOPE.replace(STRICT_V1_CIPHERTEXT, 'eA')],
    ['oversized v1', `${STRICT_V1_IV}:${'A'.repeat(65_536)}:${STRICT_V1_AUTH_TAG}`],
    ['v3 envelope without team context', '{"v":3,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"eA","tag":"AAAAAAAAAAAAAAAAAAAAAA"}'],
  ])('fails closed for %s', async (_description, payload) => {
    await expect(decryptProviderKey(payload)).rejects.toThrow();
  });
});
