import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import {
  classifyEnvelope,
  EnvelopeError,
  parseV1Envelope,
  parseV2Envelope,
} from '@routeshift/shared/provider-key-envelope';

function assertRoundTrip(envelope: string): string {
  classifyEnvelope(envelope);
  return envelope;
}

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_BYTES = 12; // AES-GCM standard IV size

function getSecret(): Buffer {
  const secret = process.env.PROVIDER_KEY_SECRET;
  if (!secret) throw new Error('PROVIDER_KEY_SECRET not set');
  const buf = Buffer.from(secret, 'hex');
  // Match proxy/billing/provider-key-crypto.ts: hard-fail on length mismatch
  // rather than silently truncating. A misconfigured secret would otherwise
  // let the dashboard encrypt with one key while the proxy refuses to start —
  // a subtle and confusing failure mode.
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `PROVIDER_KEY_SECRET must be exactly 64 hex chars (32 bytes), got ${buf.length} bytes`,
    );
  }
  return buf;
}

function getPreviousSecret(): Buffer | null {
  const secret = process.env.PROVIDER_KEY_SECRET_PREVIOUS;
  if (!secret) return null;
  const buf = Buffer.from(secret, 'hex');
  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `PROVIDER_KEY_SECRET_PREVIOUS must be exactly 64 hex chars (32 bytes), got ${buf.length} bytes`,
    );
  }
  return buf;
}

let _kmsClient: KMSClient | null = null;
function getKmsClient(): KMSClient {
  if (_kmsClient) return _kmsClient;
  _kmsClient = new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  return _kmsClient;
}

function getKmsKeyId(): string {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) throw new Error('KMS_KEY_ID not set');
  return keyId;
}

export async function encryptProviderKey(plaintext: string): Promise<string> {
  if (process.env.KMS_KEY_ID) {
    // V2: KMS Envelope Encryption
    const kms = getKmsClient();
    const keyId = getKmsKeyId();
    const res = await kms.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }));
    if (!res.Plaintext || !res.CiphertextBlob) throw new Error('KMS failed to generate data key');

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, res.Plaintext, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    
    // Clear DEK from memory
    res.Plaintext.fill(0);

    const encryptedDek = Buffer.from(res.CiphertextBlob).toString('base64');
    return assertRoundTrip(`v2:${keyId}:${encryptedDek}:${iv.toString('base64')}:${encrypted}:${authTag}`);
  }

  // V1: Legacy Symmetric Encryption
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getSecret(), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag().toString('base64');
  return assertRoundTrip(`${iv.toString('base64')}:${encrypted}:${authTag}`);
}

export async function decryptProviderKey(encrypted: string): Promise<string> {
  const scheme = classifyEnvelope(encrypted);
  if (scheme === 'kms-per-write-v2') {
    const { encryptedDek, iv, ciphertext, authTag } = parseV2Envelope(encrypted);

    const kms = getKmsClient();
    const res = await kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(encryptedDek, 'base64') }));
    if (!res.Plaintext) throw new Error('KMS failed to decrypt data key');

    const decipher = createDecipheriv(ALGORITHM, res.Plaintext, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    
    // Clear DEK from memory
    res.Plaintext.fill(0);
    
    return decrypted.toString('utf8');
  }

  if (scheme === 'team-dek-v3') {
    throw new EnvelopeError('unsupported_scheme', 'V3 envelopes require team context for decryption');
  }
  
  // V1: iv:ciphertext:authTag
  const { iv, ciphertext, authTag } = parseV1Envelope(encrypted);
  try {
    return decryptWith(getSecret(), Buffer.from(iv, 'base64'), Buffer.from(ciphertext, 'base64'), Buffer.from(authTag, 'base64'));
  } catch {
    // The proxy accepts the previous V1 secret during rotations. Dashboard
    // readiness checks must use the same window or they can reject a key the
    // proxy is still able to dispatch with.
  }

  const previousSecret = getPreviousSecret();
  if (previousSecret) {
    try {
      return decryptWith(previousSecret, Buffer.from(iv, 'base64'), Buffer.from(ciphertext, 'base64'), Buffer.from(authTag, 'base64'));
    } catch {
      // Fall through to the stable failure below.
    }
  }

  throw new Error('Failed to decrypt provider key with any available secret');
}

function decryptWith(
  secret: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
): string {
  const decipher = createDecipheriv(ALGORITHM, secret, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}
