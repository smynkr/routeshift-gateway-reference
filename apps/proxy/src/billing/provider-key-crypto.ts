import crypto from 'node:crypto';
import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { getPool } from '../db/pool.js';
import { getCooledLabels } from './rate-limit-cooldown.js';
import {
  LATENCY_MIN_SAMPLES,
  getInFlight,
  getLatencyStats,
} from './key-stats.js';
import {
  classifyEnvelope,
  parseV1Envelope,
  parseV2Envelope,
  decodeV3Envelope,
  decryptWithDek,
  buildAad,
  EnvelopeError,
  isEncryptionScheme,
  type KeyEncryptionProvider,
} from '@routeshift/shared/provider-key-envelope';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Secret helpers
// ---------------------------------------------------------------------------

let _secret: Buffer | null = null;

function getSecret(): Buffer {
  if (_secret) return _secret;
  const hex = process.env.PROVIDER_KEY_SECRET;
  if (!hex) {
    throw new Error('PROVIDER_KEY_SECRET environment variable is not set');
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `PROVIDER_KEY_SECRET must be a 64-char hex string (32 bytes), got ${buf.length} bytes`,
    );
  }
  _secret = buf;
  return _secret;
}

function getPreviousSecret(): Buffer | null {
  const hex = process.env.PROVIDER_KEY_SECRET_PREVIOUS;
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `PROVIDER_KEY_SECRET_PREVIOUS must be a 64-char hex string (32 bytes), got ${buf.length} bytes`,
    );
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

let _kmsClient: KMSClient | null = null;
function getKmsClient(): KMSClient {
  if (_kmsClient) return _kmsClient;
  _kmsClient = new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  return _kmsClient;
}

function getKmsKeyId(): string {
  const keyId = process.env.KMS_KEY_ID;
  if (!keyId) throw new Error('KMS_KEY_ID environment variable is not set');
  return keyId;
}

export async function encryptProviderKey(plaintext: string): Promise<string> {
  if (process.env.KMS_KEY_ID) {
    const kms = getKmsClient();
    const keyId = getKmsKeyId();
    const res = await kms.send(new GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }));
    if (!res.Plaintext || !res.CiphertextBlob) throw new Error('KMS failed to generate data key');

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, res.Plaintext, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    res.Plaintext.fill(0);
    const encryptedDek = Buffer.from(res.CiphertextBlob).toString('base64');
    const envelope = ['v2', keyId, encryptedDek, iv.toString('base64'), encrypted.toString('base64'), authTag.toString('base64')].join(':');
    classifyEnvelope(envelope);
    return envelope;
  }

  const secret = getSecret();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, secret, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope = [iv.toString('base64'), encrypted.toString('base64'), authTag.toString('base64')].join(':');
  classifyEnvelope(envelope);
  return envelope;
}

export async function decryptProviderKey(encrypted: string, tryPrevious = true): Promise<string> {
  const scheme = classifyEnvelope(encrypted);
  if (scheme === 'kms-per-write-v2') {
    const { encryptedDek, iv, ciphertext, authTag } = parseV2Envelope(encrypted);

    const kms = getKmsClient();
    const res = await kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(encryptedDek, 'base64') }));
    if (!res.Plaintext) throw new Error('KMS failed to decrypt data key');

    const decipher = crypto.createDecipheriv(ALGORITHM, res.Plaintext, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    
    res.Plaintext.fill(0);
    return decrypted.toString('utf8');
  }

  if (scheme === 'team-dek-v3') {
    throw new EnvelopeError('unsupported_scheme', 'V3 envelopes require team context for decryption');
  }

  const { iv, ciphertext, authTag } = parseV1Envelope(encrypted);

  // Try current secret first
  try {
    return decryptWith(getSecret(), Buffer.from(iv, 'base64'), Buffer.from(ciphertext, 'base64'), Buffer.from(authTag, 'base64'));
  } catch {
    // fall through
  }

  // Optionally try previous secret (key rotation)
  if (tryPrevious) {
    const prev = getPreviousSecret();
    if (prev) {
      try {
        return decryptWith(prev, Buffer.from(iv, 'base64'), Buffer.from(ciphertext, 'base64'), Buffer.from(authTag, 'base64'));
      } catch {
        // fall through
      }
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
  const decipher = crypto.createDecipheriv(ALGORITHM, secret, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

// ---------------------------------------------------------------------------
// RSH-88 Phase 1: v3 envelope dual-read (writes DISABLED)
// ---------------------------------------------------------------------------

let _kekAdapter: KeyEncryptionProvider | null = null;

export function setKekAdapter(adapter: KeyEncryptionProvider | null): void {
  _kekAdapter = adapter;
}

const DEK_CACHE_TTL_MS = 5 * 60 * 1000;
const dekCache = new Map<string, { dek: Uint8Array; expires: number }>();

export function clearDekCache(): void {
  dekCache.clear();
}

async function resolveTeamDek(teamId: string, dekVersion: number): Promise<Uint8Array> {
  const ck = `${teamId}:${dekVersion}`;
  const cached = dekCache.get(ck);
  if (cached && cached.expires > Date.now()) return cached.dek;

  if (!_kekAdapter) {
    throw new Error('No KEK adapter configured — cannot unwrap team DEK');
  }

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT wrapped_dek, kek_key_ref, context_version
     FROM team_data_keys
     WHERE team_id = $1 AND dek_version = $2 AND status IN ('active', 'retiring')`,
    [teamId, dekVersion],
  );

  if (rows.length === 0) {
    throw new Error(`No team DEK found for team=${teamId} version=${dekVersion}`);
  }

  const row = rows[0];
  const dek = await _kekAdapter.unwrapDataKey({
    keyReference: row.kek_key_ref as string,
    wrappedDek: row.wrapped_dek as Uint8Array,
    context: {
      routeshift_context_version: String(row.context_version),
      routeshift_team_id: teamId,
      routeshift_secret_class: 'provider_key',
      routeshift_dek_version: String(dekVersion),
    },
  });

  dekCache.set(ck, { dek, expires: Date.now() + DEK_CACHE_TTL_MS });
  return dek;
}

export async function decryptProviderKeyV3(
  payload: string,
  teamId: string,
  provider: string,
  label: string,
  dekVersion: number,
): Promise<string> {
  const envelope = decodeV3Envelope(payload);
  const dek = await resolveTeamDek(teamId, dekVersion);
  const aad = buildAad({
    context_version: 1,
    team_id: teamId,
    secret_class: 'provider_key',
    provider,
    label,
    dek_version: dekVersion,
  });
  return decryptWithDek(envelope, dek, aad).toString('utf8');
}

// ---------------------------------------------------------------------------
// Cache + DB lookup
// ---------------------------------------------------------------------------

export interface ProviderKeyConfig {
  key: string;
  metadata: Record<string, unknown>;
  /** Label of the key that was selected. Useful for logging / observability. */
  label?: string;
  /**
   * LAY-320: true when at least one other credential in this bucket was on
   * cooldown at selection time. The proxy stamps `request_logs.rate_limited`
   * from this so admins can see when traffic was reshaped around a 429.
   */
  selected_after_cooldown_skip?: boolean;
}

// LAY-319: a (team, provider) bucket can hold N keys with weight + enabled.
// The cache stores the resolved key list + strategy + a per-bucket counter
// for weighted round-robin. Selection happens on every call so RR isn't
// stuck on whichever key won the cache race.
interface KeyEntry {
  label: string;
  weight: number;
  config: ProviderKeyConfig;
}

interface BucketCacheEntry {
  keys: KeyEntry[];
  totalWeight: number;
  strategy: 'weighted_round_robin' | 'latency_based' | 'least_busy';
  /** Counter used for weighted_round_robin. Modulo totalWeight. */
  cursor: number;
  error: Error | null;
  expiresAt: number;
}

const FAILURE_TTL_MS = 30 * 1000;

const bucketCache = new Map<string, BucketCacheEntry>();

function cacheKey(teamId: string, provider: string): string {
  return `${teamId}:${provider}`;
}

async function loadBucket(teamId: string, provider: string): Promise<BucketCacheEntry> {
  const pool = getPool();
  // LAY-327: read both the keys and the team's chosen strategy in parallel.
  // The strategy column has a CHECK constraint, so we can trust the value
  // matches the union below.
  const [keysRes, strategyRes] = await Promise.all([
    pool.query(
      `SELECT label, weight, encrypted_key, metadata, encryption_scheme, encryption_key_version
       FROM provider_keys
       WHERE team_id = $1 AND provider = $2 AND enabled = true
       ORDER BY weight DESC, label ASC`,
      [teamId, provider],
    ),
    pool.query<{ strategy: 'weighted_round_robin' | 'latency_based' | 'least_busy' }>(
      `SELECT strategy FROM team_provider_strategies
       WHERE team_id = $1 AND provider = $2`,
      [teamId, provider],
    ),
  ]);
  const keyRows = keysRes.rows;
  const strategy = strategyRes.rows[0]?.strategy ?? 'weighted_round_robin';

  const keys: KeyEntry[] = [];
  for (const row of keyRows) {
    if (!row.encrypted_key) continue;
    try {
      const encryptedKey = row.encrypted_key as string;
      const classifiedScheme = classifyEnvelope(encryptedKey);
      const declaredScheme = row.encryption_scheme ?? null;
      if (declaredScheme !== null && !isEncryptionScheme(declaredScheme)) {
        throw new EnvelopeError('unsupported_scheme', 'Unsupported provider-key encryption scheme');
      }
      if (declaredScheme !== null && declaredScheme !== classifiedScheme) {
        throw new EnvelopeError('scheme_mismatch', 'Provider-key encryption scheme does not match payload');
      }
      const scheme = declaredScheme ?? classifiedScheme;
      let key: string;
      switch (scheme) {
        case 'local-v1':
        case 'kms-per-write-v2':
          key = (await decryptProviderKey(encryptedKey)).trim();
          break;
        case 'team-dek-v3':
          key = (await decryptProviderKeyV3(
            encryptedKey,
            teamId,
            provider,
            row.label as string,
            Number(row.encryption_key_version),
          )).trim();
          break;
        default:
          throw new EnvelopeError('unsupported_scheme', 'Unsupported provider-key encryption scheme');
      }
      // Legacy/corrupt whitespace-only rows are not credentials. New writes
      // reject them too, but the runtime must remain fail-closed for old data.
      if (!key) continue;
      keys.push({
        label: row.label as string,
        weight: Number(row.weight),
        config: {
          key,
          metadata: (row.metadata ?? {}) as Record<string, unknown>,
          label: row.label as string,
        },
      });
    } catch (err) {
      // Surface the decrypt failure: a bad PROVIDER_KEY_SECRET rotation
      // would otherwise look like a network blip in the outer fetch.
      console.error(
        `[provider-key-crypto] decrypt failed for team=${teamId} provider=${provider} label=${row.label}:`,
        err,
      );
      const error = err instanceof Error ? err : new Error(String(err));
      return {
        keys: [],
        totalWeight: 0,
        strategy,
        cursor: 0,
        error,
        expiresAt: Date.now() + FAILURE_TTL_MS,
      };
    }
  }

  const totalWeight = keys.reduce((s, k) => s + k.weight, 0);

  return {
    keys,
    totalWeight,
    strategy,
    cursor: 0,
    error: null,
    expiresAt: Date.now() + CACHE_TTL_MS,
  };
}

async function getCachedBucket(teamId: string, provider: string): Promise<BucketCacheEntry> {
  const ck = cacheKey(teamId, provider);
  let bucket = bucketCache.get(ck);
  if (!bucket || bucket.expiresAt <= Date.now()) {
    bucket = await loadBucket(teamId, provider);
    bucketCache.set(ck, bucket);
  }
  return bucket;
}

interface SelectionResult {
  entry: KeyEntry;
  /** True when at least one other (cooled) key was filtered out of the bucket. */
  skippedCooldown: boolean;
}

function selectKey(
  bucket: BucketCacheEntry,
  cooledLabels: Set<string>,
  teamId: string,
  provider: string,
): SelectionResult | null {
  if (bucket.keys.length === 0) return null;

  // LAY-320: prefer non-cooled keys. If all are cooled, fall through to the
  // full bucket — picking a cooled key still gives the upstream a chance to
  // recover, which is better than failing before reaching the provider.
  let pool = bucket.keys;
  let totalWeight = bucket.totalWeight;
  let skippedCooldown = false;
  if (cooledLabels.size > 0) {
    const filtered = bucket.keys.filter((k) => !cooledLabels.has(k.label));
    if (filtered.length > 0 && filtered.length < bucket.keys.length) {
      pool = filtered;
      totalWeight = filtered.reduce((s, k) => s + k.weight, 0);
      skippedCooldown = true;
    }
  }

  if (pool.length === 1) return { entry: pool[0]!, skippedCooldown };

  // LAY-327: dispatch on the team's chosen strategy. Both alternatives
  // fall back to weighted round-robin when their signals are missing
  // (latency: <10 samples on any key; least-busy never falls back since
  // in-flight=0 is a valid baseline).
  if (bucket.strategy === 'latency_based') {
    const stats = pool.map((k) => ({ k, s: getLatencyStats(teamId, provider, k.label) }));
    const allWarm = stats.every((s) => s.s.sampleCount >= LATENCY_MIN_SAMPLES);
    if (allWarm) {
      stats.sort((a, b) => a.s.p95LatencyMs - b.s.p95LatencyMs);
      return { entry: stats[0]!.k, skippedCooldown };
    }
    // Cold-start: fall through to WRR.
  }

  if (bucket.strategy === 'least_busy') {
    const annotated = pool.map((k) => ({ k, inflight: getInFlight(teamId, provider, k.label) }));
    annotated.sort((a, b) => {
      if (a.inflight !== b.inflight) return a.inflight - b.inflight;
      // Tie-break: heavier weight wins so config still matters when load
      // is balanced.
      return b.k.weight - a.k.weight;
    });
    return { entry: annotated[0]!.k, skippedCooldown };
  }

  // Weighted round-robin (default + cold-start fallback for latency_based):
  // pick by walking weights modulo totalWeight.
  const offset = bucket.cursor % Math.max(1, totalWeight);
  bucket.cursor = (bucket.cursor + 1) % Math.max(1, totalWeight * 1000);
  let acc = 0;
  for (const k of pool) {
    acc += k.weight;
    if (offset < acc) return { entry: k, skippedCooldown };
  }
  return { entry: pool[pool.length - 1]!, skippedCooldown };
}

export async function getDecryptedProviderKey(
  teamId: string,
  provider: string,
): Promise<ProviderKeyConfig | null> {
  const bucket = await getCachedBucket(teamId, provider);
  if (bucket.error) throw bucket.error;
  const cooled = getCooledLabels(teamId, provider);
  const selected = selectKey(bucket, cooled, teamId, provider);
  if (!selected) return null;

  // RSH-88: Traceable key access ahead of KMS migration (1% sample to avoid log spam).
  if (Math.random() < 0.01) {
    console.log(`[provider-key-crypto] [AUDIT] decrypt-for-use (1% sample): team=${teamId} provider=${provider} label=${selected.entry.label}`);
  }

  return {
    ...selected.entry.config,
    selected_after_cooldown_skip: selected.skippedCooldown || undefined,
  };
}

export async function hasEnabledProviderKey(teamId: string, provider: string): Promise<boolean> {
  const bucket = await getCachedBucket(teamId, provider);
  return bucket.error === null && bucket.keys.length > 0;
}

export async function getUsableProviderKeyLabels(teamId: string, provider: string): Promise<string[]> {
  const bucket = await getCachedBucket(teamId, provider);
  if (bucket.error) return [];
  return bucket.keys.map((entry) => entry.label);
}

export function clearProviderKeyCache(teamId?: string, provider?: string): void {
  if (teamId && provider) bucketCache.delete(cacheKey(teamId, provider));
  else bucketCache.clear();
}

/** @internal — for testing only */
export function _resetSecretCache(): void {
  _secret = null;
}

export function invalidateKeyCache(teamId: string, provider?: string): void {
  if (provider) {
    bucketCache.delete(cacheKey(teamId, provider));
  } else {
    for (const key of bucketCache.keys()) {
      if (key.startsWith(`${teamId}:`)) {
        bucketCache.delete(key);
      }
    }
  }
}
