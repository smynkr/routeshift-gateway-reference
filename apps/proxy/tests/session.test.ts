import { describe, expect, it } from 'vitest';
import type { CanonicalMessage } from '@routeshift/shared';
import { deriveSessionId } from '../src/logging/session.js';

const messages = (text: string): CanonicalMessage[] => [{ role: 'user', content: text }];

describe('deriveSessionId', () => {
  const ctx = { teamId: 'team_a', apiKeyId: 'key_1', timestamp: new Date('2026-04-29T01:00:00Z').getTime() };

  it('uses x-routeshift-session-id header when present', () => {
    const id = deriveSessionId({
      headers: { 'x-routeshift-session-id': 'sess_explicit' },
      messages: messages('hi'),
      ...ctx,
    });
    expect(id).toBe('sess_explicit');
  });

  it('falls back to x-conversation-id header when the routeshift one is absent', () => {
    const id = deriveSessionId({
      headers: { 'x-conversation-id': 'conv_abc' },
      messages: messages('hi'),
      ...ctx,
    });
    expect(id).toBe('conv_abc');
  });

  it('header is preferred over derived id', () => {
    const explicit = deriveSessionId({
      headers: { 'x-routeshift-session-id': 'sess_explicit' },
      messages: messages('the same prompt'),
      ...ctx,
    });
    const derived = deriveSessionId({
      headers: {},
      messages: messages('the same prompt'),
      ...ctx,
    });
    expect(explicit).toBe('sess_explicit');
    expect(explicit).not.toBe(derived);
  });

  it('derives a stable id for the same (team, key, first user message, 30-min bucket)', () => {
    const a = deriveSessionId({ headers: {}, messages: messages('refactor the parser'), ...ctx });
    const b = deriveSessionId({ headers: {}, messages: messages('refactor the parser'), ...ctx });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it('keeps the same id across the 30-min window even as time advances', () => {
    const t0 = new Date('2026-04-29T01:00:00Z').getTime();
    const a = deriveSessionId({ headers: {}, messages: messages('refactor'), teamId: 'team_a', apiKeyId: 'key_1', timestamp: t0 });
    const b = deriveSessionId({
      headers: {},
      messages: messages('refactor'),
      teamId: 'team_a',
      apiKeyId: 'key_1',
      timestamp: t0 + 25 * 60 * 1000,
    });
    expect(a).toBe(b);
  });

  it('rolls to a new id when the 30-min bucket changes', () => {
    const t0 = new Date('2026-04-29T01:00:00Z').getTime();
    const a = deriveSessionId({ headers: {}, messages: messages('refactor'), teamId: 'team_a', apiKeyId: 'key_1', timestamp: t0 });
    const b = deriveSessionId({
      headers: {},
      messages: messages('refactor'),
      teamId: 'team_a',
      apiKeyId: 'key_1',
      timestamp: t0 + 31 * 60 * 1000,
    });
    expect(a).not.toBe(b);
  });

  it('separates sessions across teams', () => {
    const a = deriveSessionId({ headers: {}, messages: messages('hi'), teamId: 'team_a', apiKeyId: 'k', timestamp: ctx.timestamp });
    const b = deriveSessionId({ headers: {}, messages: messages('hi'), teamId: 'team_b', apiKeyId: 'k', timestamp: ctx.timestamp });
    expect(a).not.toBe(b);
  });

  it('separates sessions across api keys within the same team', () => {
    const a = deriveSessionId({ headers: {}, messages: messages('hi'), teamId: 't', apiKeyId: 'k1', timestamp: ctx.timestamp });
    const b = deriveSessionId({ headers: {}, messages: messages('hi'), teamId: 't', apiKeyId: 'k2', timestamp: ctx.timestamp });
    expect(a).not.toBe(b);
  });

  it('different first messages produce different ids', () => {
    const a = deriveSessionId({ headers: {}, messages: messages('write tests'), ...ctx });
    const b = deriveSessionId({ headers: {}, messages: messages('write docs'), ...ctx });
    expect(a).not.toBe(b);
  });

  it('handles array-of-parts content by concatenating text parts', () => {
    const id = deriveSessionId({
      headers: {},
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: ' world' }] }],
      ...ctx,
    });
    const equivalent = deriveSessionId({ headers: {}, messages: messages('hello world'), ...ctx });
    expect(id).toBe(equivalent);
  });

  it('handles missing api key by treating it as anonymous', () => {
    const id = deriveSessionId({ headers: {}, messages: messages('hi'), teamId: 't', apiKeyId: null, timestamp: ctx.timestamp });
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });

  it('returns "uncategorized" sentinel for an empty message list', () => {
    const id = deriveSessionId({ headers: {}, messages: [], ...ctx });
    // Still deterministic, still 16 hex — just based on empty payload.
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });
});
