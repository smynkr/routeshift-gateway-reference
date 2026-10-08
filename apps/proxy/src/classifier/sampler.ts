import { createHash } from 'node:crypto';
import { MIN_SAMPLE_RATE_BPS, MAX_SAMPLE_RATE_BPS } from './types.js';

export function shouldSample(teamId: string, requestId: string, sampleRateBps: number): boolean {
  const clamped = Math.min(Math.max(sampleRateBps, MIN_SAMPLE_RATE_BPS), MAX_SAMPLE_RATE_BPS);
  const hash = createHash('sha256').update(`${teamId}:${requestId}`).digest();
  const bucket = hash.readUInt32BE(0) % 10_000;
  return bucket < clamped;
}
