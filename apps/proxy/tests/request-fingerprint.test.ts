import { describe, it, expect } from 'vitest';
import { estimateSystemPromptTokens, computeMessageHash } from '../src/logging/request-fingerprint.js';
import type { CanonicalRequest } from '@routeshift/shared';

function canonical(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'gpt-4.1',
    messages: [{ role: 'user', content: 'hi' }],
    system_prompt: 'You are a helpful assistant.',
    stream: false,
    ...overrides,
  };
}

describe('estimateSystemPromptTokens', () => {
  it('returns 0 for empty / non-string input', () => {
    expect(estimateSystemPromptTokens(undefined)).toBe(0);
    expect(estimateSystemPromptTokens(null)).toBe(0);
    expect(estimateSystemPromptTokens('')).toBe(0);
    expect(estimateSystemPromptTokens(123 as unknown)).toBe(0);
  });

  it('uses chars/4 ceiling', () => {
    expect(estimateSystemPromptTokens('a')).toBe(1);
    expect(estimateSystemPromptTokens('aaaa')).toBe(1);
    expect(estimateSystemPromptTokens('aaaaa')).toBe(2);
    expect(estimateSystemPromptTokens('a'.repeat(4000))).toBe(1000);
  });
});

describe('computeMessageHash', () => {
  it('produces a stable 16-char hex', () => {
    const h = computeMessageHash(canonical());
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical input', () => {
    const a = computeMessageHash(canonical());
    const b = computeMessageHash(canonical());
    expect(a).toBe(b);
  });

  it('is deterministic for identical reasoning fields', () => {
    const a = computeMessageHash(canonical({ reasoning_effort: 'high', thinking_budget_tokens: 2048 }));
    const b = computeMessageHash(canonical({ reasoning_effort: 'high', thinking_budget_tokens: 2048 }));
    expect(a).toBe(b);
  });

  it('changes when messages change', () => {
    const a = computeMessageHash(canonical());
    const b = computeMessageHash(canonical({ messages: [{ role: 'user', content: 'different' }] }));
    expect(a).not.toBe(b);
  });

  it('changes when system_prompt changes', () => {
    const a = computeMessageHash(canonical());
    const b = computeMessageHash(canonical({ system_prompt: 'You are not.' }));
    expect(a).not.toBe(b);
  });

  it('treats missing system_prompt the same as empty string', () => {
    const a = computeMessageHash(canonical({ system_prompt: '' }));
    const b = computeMessageHash(canonical({ system_prompt: undefined }));
    expect(a).toBe(b);
  });

  it('changes when tools change', () => {
    const a = computeMessageHash(canonical({ tools: [] }));
    const b = computeMessageHash(canonical({ tools: [{ name: 't', description: '', input_schema: { type: 'object' } }] }));
    expect(a).not.toBe(b);
  });

  it('changes when reasoning_effort changes', () => {
    const a = computeMessageHash(canonical({ reasoning_effort: 'low' }));
    const b = computeMessageHash(canonical({ reasoning_effort: 'high' }));
    expect(a).not.toBe(b);
  });

  it('changes when thinking_budget_tokens changes', () => {
    const a = computeMessageHash(canonical({ thinking_budget_tokens: 1024 }));
    const b = computeMessageHash(canonical({ thinking_budget_tokens: 4096 }));
    expect(a).not.toBe(b);
  });

  it('changes when Gemini thinking_level changes', () => {
    const a = computeMessageHash(canonical({ thinking_level: 'low' }));
    const b = computeMessageHash(canonical({ thinking_level: 'high' }));
    expect(a).not.toBe(b);
  });
});
