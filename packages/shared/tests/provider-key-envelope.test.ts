import { describe, it, expect } from 'vitest';
import {
  encodeV3Envelope,
  decodeV3Envelope,
  encryptWithDek,
  decryptWithDek,
  buildAad,
  buildKmsContext,
  classifyEnvelope,
  parseV1Envelope,
  parseV2Envelope,
  EnvelopeError,
  type V3Envelope,
  type AadContext,
} from '../src/provider-key-envelope.js';
import { randomBytes } from 'node:crypto';

const TEST_DEK = randomBytes(32);
const MAX_ENVELOPE_BYTES = 65_536;
const V2_KMS_ARN = 'arn:aws:kms:us-east-1:123456789012:key/abc';
const V2_ENCRYPTED_DEK = Buffer.from('wrapped-dek').toString('base64');
const V2_IV = Buffer.alloc(12, 1).toString('base64');
const V2_CIPHERTEXT = Buffer.from('provider-key-ciphertext').toString('base64');
const V2_AUTH_TAG = Buffer.alloc(16, 2).toString('base64');
const V1_ENVELOPE = [
  Buffer.alloc(12, 3).toString('base64'),
  Buffer.from('provider-key-ciphertext').toString('base64'),
  Buffer.alloc(16, 4).toString('base64'),
].join(':');
const [V1_IV, V1_CIPHERTEXT, V1_AUTH_TAG] = V1_ENVELOPE.split(':') as [string, string, string];

function v1Envelope({
  iv = V1_IV,
  ciphertext = V1_CIPHERTEXT,
  authTag = V1_AUTH_TAG,
}: Partial<{ iv: string; ciphertext: string; authTag: string }> = {}): string {
  return [iv, ciphertext, authTag].join(':');
}

function v2Envelope({
  keyId = V2_KMS_ARN,
  encryptedDek = V2_ENCRYPTED_DEK,
  iv = V2_IV,
  ciphertext = V2_CIPHERTEXT,
  authTag = V2_AUTH_TAG,
}: Partial<{
  keyId: string;
  encryptedDek: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}> = {}): string {
  return ['v2', keyId, encryptedDek, iv, ciphertext, authTag].join(':');
}

const TEST_AAD_CTX: AadContext = {
  context_version: 1,
  team_id: 'team-alpha',
  secret_class: 'provider_key',
  provider: 'openai',
  label: 'default',
  dek_version: 1,
};

describe('v3 envelope codec', () => {
  it('round-trips encrypt → encode → decode → decrypt', () => {
    const plaintext = Buffer.from('sk-test-provider-key-12345', 'utf8');
    const aad = buildAad(TEST_AAD_CTX);
    const envelope = encryptWithDek(plaintext, TEST_DEK, aad);
    const encoded = encodeV3Envelope(envelope);
    const decoded = decodeV3Envelope(encoded);
    const decrypted = decryptWithDek(decoded, TEST_DEK, aad);
    expect(decrypted.toString('utf8')).toBe('sk-test-provider-key-12345');
  });

  it('produces unique IVs per encryption', () => {
    const aad = buildAad(TEST_AAD_CTX);
    const e1 = encryptWithDek(Buffer.from('a'), TEST_DEK, aad);
    const e2 = encryptWithDek(Buffer.from('a'), TEST_DEK, aad);
    expect(e1.iv).not.toBe(e2.iv);
  });

  it('rejects unknown envelope version', () => {
    expect(() => decodeV3Envelope('{"v":4,"alg":"A256GCM","iv":"x","ciphertext":"y","tag":"z"}'))
      .toThrow(EnvelopeError);
    try { decodeV3Envelope('{"v":4}'); } catch (e) {
      expect((e as EnvelopeError).code).toBe('unknown_version');
    }
  });

  it('rejects malformed JSON', () => {
    try { decodeV3Envelope('not-json'); } catch (e) {
      expect((e as EnvelopeError).code).toBe('malformed_envelope');
    }
  });

  it('rejects unknown fields', () => {
    const valid = encryptWithDek(Buffer.from('x'), TEST_DEK, buildAad(TEST_AAD_CTX));
    const tampered = { ...valid, extra: 'field' };
    try { decodeV3Envelope(JSON.stringify(tampered)); } catch (e) {
      expect((e as EnvelopeError).code).toBe('unknown_field');
    }
  });

  it('rejects oversized envelopes', () => {
    const big = 'x'.repeat(70_000);
    try { decodeV3Envelope(big); } catch (e) {
      expect((e as EnvelopeError).code).toBe('oversized_envelope');
    }
  });

  it('rejects wrong IV length', () => {
    const bad: V3Envelope = { v: 3, alg: 'A256GCM', iv: 'c2hvcnQ', ciphertext: 'eA', tag: 'c2hvcnR0YWdzaG9ydA' };
    try { decodeV3Envelope(JSON.stringify(bad)); } catch (e) {
      expect((e as EnvelopeError).code).toBe('malformed_envelope');
    }
  });

  it.each([
    ['standard base64 alphabet', 'iv', '////////////////'],
    ['padding', 'tag', 'AAAAAAAAAAAAAAAAAAAAAA=='],
    ['non-canonical encoding', 'ciphertext', 'A'],
    ['non-canonical trailing bits', 'tag', 'AAAAAAAAAAAAAAAAAAAAAB'],
  ])('rejects %s', (_description, field, value) => {
    const valid = encryptWithDek(Buffer.from('x'), TEST_DEK, buildAad(TEST_AAD_CTX));
    const malformed = { ...valid, [field]: value };
    expect(() => decodeV3Envelope(JSON.stringify(malformed))).toThrow(EnvelopeError);
    try { decodeV3Envelope(JSON.stringify(malformed)); } catch (e) {
      expect((e as EnvelopeError).code).toBe('malformed_envelope');
    }
  });

  it('rejects empty ciphertext strings', () => {
    const valid = encryptWithDek(Buffer.from('x'), TEST_DEK, buildAad(TEST_AAD_CTX));
    const malformed = { ...valid, ciphertext: '' };
    expect(() => decodeV3Envelope(JSON.stringify(malformed))).toThrow(EnvelopeError);
    try { decodeV3Envelope(JSON.stringify(malformed)); } catch (e) {
      expect((e as EnvelopeError).code).toBe('truncated_envelope');
    }
  });

  it('applies the envelope limit to UTF-8 bytes, not UTF-16 code units', () => {
    const multibytePadding = '界'.repeat(22_000);
    const payload = JSON.stringify({
      v: 3,
      alg: 'A256GCM',
      iv: 'AAAAAAAAAAAAAAAA',
      ciphertext: 'eA',
      tag: 'AAAAAAAAAAAAAAAAAAAAAA',
      padding: multibytePadding,
    });
    expect(payload.length).toBeLessThan(MAX_ENVELOPE_BYTES);
    expect(Buffer.byteLength(payload, 'utf8')).toBeGreaterThan(MAX_ENVELOPE_BYTES);
    expect(() => decodeV3Envelope(payload)).toThrow(EnvelopeError);
    try { decodeV3Envelope(payload); } catch (e) {
      expect((e as EnvelopeError).code).toBe('oversized_envelope');
    }
  });

  it('accepts an envelope at the exact byte limit and rejects one byte over', () => {
    const prefix = '{"v":3,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ciphertext":"';
    const suffix = '","tag":"AAAAAAAAAAAAAAAAAAAAAA"}';
    const ciphertextLength = MAX_ENVELOPE_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    // Remainders 0, 2, and 3 are canonical unpadded base64url lengths.
    expect(ciphertextLength % 4).not.toBe(1);
    const atLimit = `${prefix}${'A'.repeat(ciphertextLength)}${suffix}`;
    expect(Buffer.byteLength(atLimit)).toBe(MAX_ENVELOPE_BYTES);
    expect(decodeV3Envelope(atLimit).ciphertext).toHaveLength(ciphertextLength);

    const oversized = `${prefix}${'A'.repeat(ciphertextLength + 1)}${suffix}`;
    expect(() => decodeV3Envelope(oversized)).toThrow(EnvelopeError);
    try { decodeV3Envelope(oversized); } catch (e) {
      expect((e as EnvelopeError).code).toBe('oversized_envelope');
    }
  });
});

describe('AAD mismatch fails authentication', () => {
  it('decrypt fails when team_id differs', () => {
    const aad1 = buildAad(TEST_AAD_CTX);
    const aad2 = buildAad({ ...TEST_AAD_CTX, team_id: 'team-other' });
    const envelope = encryptWithDek(Buffer.from('secret'), TEST_DEK, aad1);
    expect(() => decryptWithDek(envelope, TEST_DEK, aad2)).toThrow(EnvelopeError);
    try { decryptWithDek(envelope, TEST_DEK, aad2); } catch (e) {
      expect((e as EnvelopeError).code).toBe('decrypt_failed');
    }
  });

  it('decrypt fails when provider differs', () => {
    const aad1 = buildAad(TEST_AAD_CTX);
    const aad2 = buildAad({ ...TEST_AAD_CTX, provider: 'anthropic' });
    const envelope = encryptWithDek(Buffer.from('secret'), TEST_DEK, aad1);
    expect(() => decryptWithDek(envelope, TEST_DEK, aad2)).toThrow(EnvelopeError);
  });

  it('decrypt fails when dek_version differs', () => {
    const aad1 = buildAad(TEST_AAD_CTX);
    const aad2 = buildAad({ ...TEST_AAD_CTX, dek_version: 2 });
    const envelope = encryptWithDek(Buffer.from('secret'), TEST_DEK, aad1);
    expect(() => decryptWithDek(envelope, TEST_DEK, aad2)).toThrow(EnvelopeError);
  });

  it('decrypt fails with wrong DEK', () => {
    const aad = buildAad(TEST_AAD_CTX);
    const envelope = encryptWithDek(Buffer.from('secret'), TEST_DEK, aad);
    const wrongDek = randomBytes(32);
    expect(() => decryptWithDek(envelope, wrongDek, aad)).toThrow(EnvelopeError);
  });
});

describe('canonical AAD builder', () => {
  it('produces different AAD for different field boundaries', () => {
    // team_id="ab", provider="c" vs team_id="a", provider="bc"
    const aad1 = buildAad({ ...TEST_AAD_CTX, team_id: 'ab', provider: 'c' });
    const aad2 = buildAad({ ...TEST_AAD_CTX, team_id: 'a', provider: 'bc' });
    expect(aad1.equals(aad2)).toBe(false);
  });

  it('is deterministic for the same context', () => {
    const aad1 = buildAad(TEST_AAD_CTX);
    const aad2 = buildAad(TEST_AAD_CTX);
    expect(aad1.equals(aad2)).toBe(true);
  });
});

describe('KMS context builder', () => {
  it('produces the stable subset for DEK unwrap', () => {
    const ctx = buildKmsContext(TEST_AAD_CTX);
    expect(ctx).toEqual({
      routeshift_context_version: '1',
      routeshift_team_id: 'team-alpha',
      routeshift_secret_class: 'provider_key',
      routeshift_dek_version: '1',
    });
    // Must NOT include provider or label (those are AAD-only).
    expect(ctx).not.toHaveProperty('provider');
    expect(ctx).not.toHaveProperty('label');
  });
});

describe('classifyEnvelope', () => {
  it('classifies v1 (iv:ciphertext:authTag)', () => {
    expect(classifyEnvelope(V1_ENVELOPE)).toBe('local-v1');
  });

  it('classifies actual current v2 serializer output', () => {
    expect(classifyEnvelope(v2Envelope({ keyId: 'key-id' }))).toBe('kms-per-write-v2');
  });

  it('classifies a v2 envelope with a colon-bearing KMS ARN key ID', () => {
    expect(classifyEnvelope(v2Envelope())).toBe('kms-per-write-v2');
  });

  it('retains aws-kms:// as classification-only compatibility and legacy readers fail it closed', () => {
    expect(classifyEnvelope('aws-kms://key-id:ciphertext:dek')).toBe('kms-per-write-v2');
    expect(() => parseV2Envelope('aws-kms://key-id:ciphertext:dek')).toThrow(EnvelopeError);
  });

  it('classifies v3 (JSON with v:3)', () => {
    const envelope = encryptWithDek(Buffer.from('x'), TEST_DEK, buildAad(TEST_AAD_CTX));
    expect(classifyEnvelope(encodeV3Envelope(envelope))).toBe('team-dek-v3');
  });

  it('rejects unknown or malformed JSON instead of falling back to v1', () => {
    expect(() => classifyEnvelope('{"foo":"bar"}')).toThrow(EnvelopeError);
    expect(() => classifyEnvelope('  {"foo":"bar"}')).toThrow(EnvelopeError);
    expect(() => classifyEnvelope('{not-json')).toThrow(EnvelopeError);
  });

  it('rejects malformed v1 and garbage payloads', () => {
    expect(() => classifyEnvelope('')).toThrow(EnvelopeError);
    expect(() => classifyEnvelope('not-encrypted')).toThrow(EnvelopeError);
    expect(() => classifyEnvelope('iv::auth-tag')).toThrow(EnvelopeError);
    expect(() => classifyEnvelope('iv:ciphertext:auth-tag')).toThrow(EnvelopeError);
    expect(() => classifyEnvelope('iv:ciphertext:auth-tag:extra')).toThrow(EnvelopeError);
  });

  it('enforces the UTF-8 byte limit before classifying', () => {
    expect(() => classifyEnvelope('界'.repeat(22_000))).toThrow(EnvelopeError);
  });
});

describe('v1 envelope parser', () => {
  it('accepts the canonical legacy writer format', () => {
    expect(parseV1Envelope(V1_ENVELOPE)).toEqual({
      v: 1,
      iv: V1_IV,
      ciphertext: V1_CIPHERTEXT,
      authTag: V1_AUTH_TAG,
    });
  });

  it.each([
    ['whitespace', v1Envelope({ iv: ` ${V1_IV}` })],
    ['non-canonical base64', v1Envelope({ ciphertext: V1_CIPHERTEXT.replace(/=+$/, '') })],
    ['empty ciphertext', v1Envelope({ ciphertext: '' })],
    ['wrong IV length', v1Envelope({ iv: Buffer.alloc(11).toString('base64') })],
    ['wrong auth tag length', v1Envelope({ authTag: Buffer.alloc(15).toString('base64') })],
    ['too many fields', `${V1_ENVELOPE}:extra`],
  ])('rejects %s', (_description, payload) => {
    expect(() => parseV1Envelope(payload)).toThrow(EnvelopeError);
  });

  it('rejects an oversized legacy envelope before splitting', () => {
    expect(() => parseV1Envelope(`${V1_IV}:${'A'.repeat(MAX_ENVELOPE_BYTES)}:${V1_AUTH_TAG}`)).toThrow(EnvelopeError);
  });
});

describe('v2 envelope parser', () => {
  it('preserves a full KMS ARN as an opaque key ID', () => {
    expect(parseV2Envelope(v2Envelope())).toEqual({
      v: 2,
      keyId: V2_KMS_ARN,
      encryptedDek: V2_ENCRYPTED_DEK,
      iv: V2_IV,
      ciphertext: V2_CIPHERTEXT,
      authTag: V2_AUTH_TAG,
    });
  });

  it.each([
    'v1:key:encrypted-dek:iv:ciphertext:auth-tag',
    'v2:key:encrypted-dek:iv:ciphertext',
    v2Envelope({ keyId: '' }),
    v2Envelope({ encryptedDek: '' }),
    v2Envelope({ iv: '' }),
    v2Envelope({ ciphertext: '' }),
    v2Envelope({ authTag: '' }),
  ])('rejects malformed required fields: %s', (payload) => {
    expect(() => parseV2Envelope(payload)).toThrow(EnvelopeError);
  });

  it.each([
    ['encrypted DEK', { encryptedDek: 'not-base64' }],
    ['iv', { iv: 'not-base64' }],
    ['ciphertext', { ciphertext: 'not-base64' }],
    ['auth tag', { authTag: 'not-base64' }],
    ['auth tag trailing bits', { authTag: 'AAAAAAAAAAAAAAAAAAAAAB==' }],
  ])('rejects non-canonical standard base64 in %s', (_field, overrides) => {
    expect(() => parseV2Envelope(v2Envelope(overrides))).toThrow(EnvelopeError);
  });

  it.each([
    ['wrong IV length', { iv: Buffer.alloc(11).toString('base64') }],
    ['wrong auth tag length', { authTag: Buffer.alloc(15).toString('base64') }],
  ])('rejects %s', (_description, overrides) => {
    expect(() => parseV2Envelope(v2Envelope(overrides))).toThrow(EnvelopeError);
  });

  it('rejects oversized direct v2 reads before splitting the payload', () => {
    expect(() => parseV2Envelope(`v2:key:${'A'.repeat(MAX_ENVELOPE_BYTES)}`)).toThrow(EnvelopeError);
  });
});
