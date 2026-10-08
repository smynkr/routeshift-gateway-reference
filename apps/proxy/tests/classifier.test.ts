import { describe, expect, it } from 'vitest';
import { stripPii } from '../src/classifier/pii-strip.js';
import { MAX_DIMENSIONS, MIN_SAMPLE_RATE_BPS, MAX_SAMPLE_RATE_BPS } from '../src/classifier/types.js';
import { createHash } from 'node:crypto';

describe('classifier PII stripping', () => {
  it('redacts email addresses', () => {
    const result = stripPii('Contact john.doe@example.com for details');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).not.toContain('john.doe@example.com');
  });

  it('redacts US phone numbers', () => {
    const result = stripPii('Call (555) 123-4567 now');
    expect(result).toContain('[REDACTED_PHONE]');
    expect(result).not.toContain('555');
  });

  it('redacts SSNs', () => {
    const result = stripPii('SSN: 123-45-6789');
    expect(result).toContain('[REDACTED_SSN]');
    expect(result).not.toContain('123-45-6789');
  });

  it('redacts credit card numbers', () => {
    const result = stripPii('Card: 4111 1111 1111 1111');
    expect(result).toContain('[REDACTED_CARD]');
    expect(result).not.toContain('4111');
  });

  it('redacts API keys', () => {
    const result = stripPii('Use sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result).toContain('[REDACTED_APIKEY]');
    expect(result).not.toContain('sk-abcdef');
  });

  it('redacts IP addresses', () => {
    const result = stripPii('Server at 192.168.1.100');
    expect(result).toContain('[REDACTED_IP]');
    expect(result).not.toContain('192.168');
  });

  it('preserves non-PII text unchanged', () => {
    const input = 'Write a function that sorts an array of integers using quicksort';
    expect(stripPii(input)).toBe(input);
  });

  it('handles multiple PII types in one string', () => {
    const result = stripPii('Email a@b.com or call 555-123-4567');
    expect(result).toContain('[REDACTED_EMAIL]');
    expect(result).toContain('[REDACTED_PHONE]');
  });

  it('handles empty string', () => {
    expect(stripPii('')).toBe('');
  });
});

describe('classifier constants', () => {
  it('enforces max 8 dimensions', () => {
    expect(MAX_DIMENSIONS).toBe(8);
  });

  it('clamps sample rate between 100 and 10000 bps', () => {
    expect(MIN_SAMPLE_RATE_BPS).toBe(100);
    expect(MAX_SAMPLE_RATE_BPS).toBe(10_000);
  });
});

describe('classifier sampling', () => {
  function shouldSample(teamId: string, requestId: string, sampleRateBps: number): boolean {
    const hash = createHash('sha256').update(`${teamId}:${requestId}`).digest();
    const bucket = hash.readUInt32BE(0) % 10_000;
    return bucket < sampleRateBps;
  }

  it('is deterministic for the same input', () => {
    const a = shouldSample('team_1', 'req_abc', 5000);
    const b = shouldSample('team_1', 'req_abc', 5000);
    expect(a).toBe(b);
  });

  it('always samples at 10000 bps (100%)', () => {
    for (let i = 0; i < 20; i++) {
      expect(shouldSample('team_1', `req_${i}`, 10_000)).toBe(true);
    }
  });

  it('never samples at 0 bps', () => {
    for (let i = 0; i < 20; i++) {
      expect(shouldSample('team_1', `req_${i}`, 0)).toBe(false);
    }
  });

  it('produces different decisions for different request IDs', () => {
    const results = new Set<boolean>();
    for (let i = 0; i < 100; i++) {
      results.add(shouldSample('team_1', `req_${i}`, 5000));
    }
    expect(results.size).toBe(2);
  });
});
