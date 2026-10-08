/**
 * RSH-88 Phase 1 — provider-key envelope codec, KEK adapter interface,
 * and canonical AAD builder.
 *
 * The v3 envelope is AES-256-GCM with a per-team DEK. The DEK is wrapped
 * by a KEK behind the KeyEncryptionProvider adapter (AWS KMS first impl).
 * V3 writes are DISABLED in Phase 1 — this module provides the read path,
 * codec, and adapter contract only.
 *
 * Design: docs/rsh-88-kms-envelope-encryption-design.md
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// ─── Typed errors ───────────────────────────────────────────────────────────

export type EnvelopeErrorCode =
  | 'unknown_version'
  | 'malformed_envelope'
  | 'truncated_envelope'
  | 'oversized_envelope'
  | 'unknown_field'
  | 'aad_mismatch'
  | 'decrypt_failed'
  | 'kek_unwrap_failed'
  | 'kek_generate_failed'
  | 'kek_unavailable'
  | 'dek_not_found'
  | 'dek_version_mismatch'
  | 'unsupported_scheme'
  | 'scheme_mismatch';

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode;
  constructor(code: EnvelopeErrorCode, message: string) {
    super(message);
    this.name = 'EnvelopeError';
    this.code = code;
  }
}

// ─── V3 envelope ────────────────────────────────────────────────────────────

export interface V3Envelope {
  v: 3;
  alg: 'A256GCM';
  iv: string;       // base64url
  ciphertext: string; // base64url
  tag: string;       // base64url
}

/**
 * Current per-write KMS envelope. `keyId` is opaque because KMS aliases and
 * ARNs may themselves contain colons.
 */
export interface V2Envelope {
  v: 2;
  keyId: string;
  encryptedDek: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface V1Envelope {
  v: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
}

const MAX_ENVELOPE_BYTES = 65_536;
const IV_BYTES = 12; // 96-bit GCM nonce
const TAG_BYTES = 16;

function assertEnvelopeSize(payload: string): void {
  if (Buffer.byteLength(payload, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new EnvelopeError('oversized_envelope', `Envelope exceeds ${MAX_ENVELOPE_BYTES} bytes`);
  }
}

export function encodeV3Envelope(envelope: V3Envelope): string {
  return JSON.stringify(envelope);
}

export function decodeV3Envelope(payload: string): V3Envelope {
  assertEnvelopeSize(payload);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new EnvelopeError('malformed_envelope', 'Envelope is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError('malformed_envelope', 'Envelope is not a JSON object');
  }

  if (parsed.v !== 3) {
    throw new EnvelopeError('unknown_version', `Unsupported envelope version: ${String(parsed.v)}`);
  }
  if (parsed.alg !== 'A256GCM') {
    throw new EnvelopeError('malformed_envelope', `Unsupported algorithm: ${String(parsed.alg)}`);
  }

  const allowedFields = new Set(['v', 'alg', 'iv', 'ciphertext', 'tag']);
  for (const key of Object.keys(parsed)) {
    if (!allowedFields.has(key)) {
      throw new EnvelopeError('unknown_field', `Unexpected envelope field: ${key}`);
    }
  }

  for (const field of ['iv', 'ciphertext', 'tag'] as const) {
    if (typeof parsed[field] !== 'string' || (parsed[field] as string).length === 0) {
      throw new EnvelopeError('truncated_envelope', `Missing or empty field: ${field}`);
    }
  }

  const iv = decodeCanonicalBase64Url(parsed.iv as string, 'iv');
  if (iv.length !== IV_BYTES) {
    throw new EnvelopeError('malformed_envelope', `IV must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  decodeCanonicalBase64Url(parsed.ciphertext as string, 'ciphertext');
  const tag = decodeCanonicalBase64Url(parsed.tag as string, 'tag');
  if (tag.length !== TAG_BYTES) {
    throw new EnvelopeError('malformed_envelope', `Auth tag must be ${TAG_BYTES} bytes, got ${tag.length}`);
  }

  return { v: 3, alg: 'A256GCM', iv: parsed.iv as string, ciphertext: parsed.ciphertext as string, tag: parsed.tag as string };
}

/**
 * Node's base64url decoder is intentionally permissive. Stored envelopes must
 * use the unpadded base64url alphabet and its unique canonical representation.
 */
function decodeCanonicalBase64Url(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new EnvelopeError('malformed_envelope', `Invalid base64url encoding for ${field}`);
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new EnvelopeError('malformed_envelope', `Non-canonical base64url encoding for ${field}`);
  }
  return decoded;
}

/** Stored v2 fields use the current writer's padded standard-base64 format. */
function decodeCanonicalBase64(value: string, field: string): Buffer {
  if (
    value.length === 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new EnvelopeError('malformed_envelope', `Invalid base64 encoding for ${field}`);
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new EnvelopeError('malformed_envelope', `Non-canonical base64 encoding for ${field}`);
  }
  return decoded;
}

/**
 * Parse the current KMS envelope format:
 * v2:<opaque-key-id>:<encrypted-dek>:<iv>:<ciphertext>:<auth-tag>
 *
 * The payload is parsed from the right so a KMS alias or full ARN round-trips
 * without imposing a second, incompatible key-ID grammar.
 */
export function parseV2Envelope(payload: string): V2Envelope {
  assertEnvelopeSize(payload);
  const parts = payload.split(':');
  if (parts[0] !== 'v2') {
    throw new EnvelopeError('unknown_version', 'Unsupported envelope version');
  }
  if (parts.length < 6) {
    throw new EnvelopeError('truncated_envelope', 'V2 envelope is missing required fields');
  }

  const [encryptedDek, iv, ciphertext, authTag] = parts.slice(-4);
  const keyId = parts.slice(1, -4).join(':');
  if (!keyId || !encryptedDek || !iv || !ciphertext || !authTag) {
    throw new EnvelopeError('truncated_envelope', 'V2 envelope has an empty required field');
  }

  decodeCanonicalBase64(encryptedDek, 'encrypted DEK');
  const decodedIv = decodeCanonicalBase64(iv, 'iv');
  if (decodedIv.length !== IV_BYTES) {
    throw new EnvelopeError('malformed_envelope', `IV must be ${IV_BYTES} bytes, got ${decodedIv.length}`);
  }
  decodeCanonicalBase64(ciphertext, 'ciphertext');
  const decodedAuthTag = decodeCanonicalBase64(authTag, 'auth tag');
  if (decodedAuthTag.length !== TAG_BYTES) {
    throw new EnvelopeError('malformed_envelope', `Auth tag must be ${TAG_BYTES} bytes, got ${decodedAuthTag.length}`);
  }

  return { v: 2, keyId, encryptedDek, iv, ciphertext, authTag };
}

/** Parse the legacy local-secret envelope: iv:ciphertext:authTag. */
export function parseV1Envelope(payload: string): V1Envelope {
  assertEnvelopeSize(payload);
  const parts = payload.split(':');
  if (parts.length !== 3 || !parts.every(Boolean)) {
    throw new EnvelopeError('malformed_envelope', 'Invalid encrypted key format — expected iv:ciphertext:authTag');
  }

  const [iv, ciphertext, authTag] = parts;
  const decodedIv = decodeCanonicalBase64(iv, 'iv');
  if (decodedIv.length !== IV_BYTES) {
    throw new EnvelopeError('malformed_envelope', `IV must be ${IV_BYTES} bytes, got ${decodedIv.length}`);
  }
  decodeCanonicalBase64(ciphertext, 'ciphertext');
  const decodedAuthTag = decodeCanonicalBase64(authTag, 'auth tag');
  if (decodedAuthTag.length !== TAG_BYTES) {
    throw new EnvelopeError('malformed_envelope', `Auth tag must be ${TAG_BYTES} bytes, got ${decodedAuthTag.length}`);
  }

  return { v: 1, iv, ciphertext, authTag };
}

// ─── AES-256-GCM encrypt/decrypt ────────────────────────────────────────────

export function encryptWithDek(plaintext: Buffer, dek: Uint8Array, aad: Buffer): V3Envelope {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 3,
    alg: 'A256GCM',
    iv: iv.toString('base64url'),
    ciphertext: encrypted.toString('base64url'),
    tag: tag.toString('base64url'),
  };
}

export function decryptWithDek(envelope: V3Envelope, dek: Uint8Array, aad: Buffer): Buffer {
  const iv = Buffer.from(envelope.iv, 'base64url');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
  const tag = Buffer.from(envelope.tag, 'base64url');
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new EnvelopeError('decrypt_failed', 'AES-256-GCM decryption failed (AAD or key mismatch)');
  }
}

// ─── Canonical AAD builder ──────────────────────────────────────────────────

export interface AadContext {
  context_version: number;
  team_id: string;
  secret_class: string;
  provider: string;
  label: string;
  dek_version: number;
}

/**
 * Build the canonical AAD for AES-256-GCM. Length-prefixed encoding prevents
 * ambiguity between field boundaries (same approach as RSH-85 shadow sampling).
 */
export function buildAad(ctx: AadContext): Buffer {
  const fields = [
    `context_version=${ctx.context_version}`,
    `team_id=${ctx.team_id}`,
    `secret_class=${ctx.secret_class}`,
    `provider=${ctx.provider}`,
    `label=${ctx.label}`,
    `dek_version=${ctx.dek_version}`,
  ];
  const parts: Buffer[] = [];
  for (const field of fields) {
    const utf8 = Buffer.from(field, 'utf8');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(utf8.length, 0);
    parts.push(prefix, utf8);
  }
  return Buffer.concat(parts);
}

/**
 * Build the KMS encryption context (stable subset for DEK unwrap).
 * This is a plain key-value map, not length-prefixed — AWS KMS applies
 * its own canonical encoding to the encryption context.
 */
export function buildKmsContext(ctx: Pick<AadContext, 'context_version' | 'team_id' | 'secret_class' | 'dek_version'>): Record<string, string> {
  return {
    routeshift_context_version: String(ctx.context_version),
    routeshift_team_id: ctx.team_id,
    routeshift_secret_class: ctx.secret_class,
    routeshift_dek_version: String(ctx.dek_version),
  };
}

// ─── KEK adapter interface ──────────────────────────────────────────────────

/**
 * Provider-neutral key-encryption-key boundary. Application code depends on
 * this interface, never on a specific KMS SDK. The first implementation is
 * AWS KMS; another provider requires a new adapter, not conditionals here.
 */
export interface KeyEncryptionProvider {
  generateDataKey(input: {
    keyReference: string;
    context: Record<string, string>;
  }): Promise<{ plaintextDek: Uint8Array; wrappedDek: Uint8Array }>;

  unwrapDataKey(input: {
    keyReference: string;
    wrappedDek: Uint8Array;
    context: Record<string, string>;
  }): Promise<Uint8Array>;

  rewrapDataKey?(input: {
    sourceKeyReference: string;
    destinationKeyReference: string;
    wrappedDek: Uint8Array;
    context: Record<string, string>;
  }): Promise<Uint8Array>;
}

// ─── Scheme classification ──────────────────────────────────────────────────

export type EncryptionScheme = 'local-v1' | 'kms-per-write-v2' | 'team-dek-v3';

const ENCRYPTION_SCHEMES: ReadonlySet<string> = new Set<EncryptionScheme>([
  'local-v1',
  'kms-per-write-v2',
  'team-dek-v3',
]);

/** Runtime guard for the declared `encryption_scheme` column. */
export function isEncryptionScheme(value: unknown): value is EncryptionScheme {
  return typeof value === 'string' && ENCRYPTION_SCHEMES.has(value);
}

/**
 * Classify a stored provider-key payload by its encryption scheme WITHOUT
 * decrypting. Phase 0 inventory uses this to count rows by scheme.
 */
export function classifyEnvelope(payload: string): EncryptionScheme {
  assertEnvelopeSize(payload);
  if (payload.trimStart().startsWith('{')) {
    decodeV3Envelope(payload);
    return 'team-dek-v3';
  }
  // aws-kms:// remains a classification-only compatibility tag. It has no
  // inferred layout and legacy readers reject it closed during decryption.
  if (payload.startsWith('v2:')) {
    parseV2Envelope(payload);
    return 'kms-per-write-v2';
  }
  if (payload.startsWith('aws-kms://')) return 'kms-per-write-v2';

  parseV1Envelope(payload);
  return 'local-v1';
}
