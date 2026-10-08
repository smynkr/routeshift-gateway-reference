import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// We construct our own instance instead of using the module-level singleton
// so we can control TTL and capacity.
// Import the class via a slightly different path — the module only exports
// a singleton, so we need dynamic access.
// Instead, let's re-create the class behaviour by importing the singleton and
// building requests.

// The module exports a singleton `responseCache` created with defaults.
// For fine-grained control we'll import the file and work with it.

import { responseCache } from '../src/cache/response-cache.js';
import type { CanonicalRequest } from '@routeshift/shared';

function makeCanonical(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'gpt-4.1',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    ...overrides,
  } as CanonicalRequest;
}

const cacheEntry = {
  body: { id: 'resp_1', choices: [] },
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  teamId: 'team_1',
  provider: 'openai',
  model: 'gpt-4.1',
};

beforeEach(() => {
  responseCache.clear();
});

afterAll(() => {
  responseCache.shutdown();
});

// ---------------------------------------------------------------------------
// isCacheable
// ---------------------------------------------------------------------------
describe('isCacheable', () => {
  it('temperature=0, no stream, no tools is cacheable', () => {
    const req = makeCanonical({ temperature: 0 });
    expect(responseCache.isCacheable(req)).toBe(true);
  });

  it('temperature undefined (provider-default sampling, ~1.0) is NOT cacheable', () => {
    // Omitting temperature is NOT 0 at the provider — it samples at the default.
    // Caching it would replay a non-deterministic generation (RSH-59).
    const req = makeCanonical({ temperature: undefined });
    expect(responseCache.isCacheable(req)).toBe(false);
  });

  it('temperature > 0 is not cacheable', () => {
    const req = makeCanonical({ temperature: 0.7 });
    expect(responseCache.isCacheable(req)).toBe(false);
  });

  it('stream=true is not cacheable', () => {
    const req = makeCanonical({ stream: true, temperature: 0 });
    expect(responseCache.isCacheable(req)).toBe(false);
  });

  it('tools present is not cacheable', () => {
    const req = makeCanonical({
      temperature: 0,
      tools: [{ name: 'get_weather', description: 'Get weather', parameters: {} }] as any,
    });
    expect(responseCache.isCacheable(req)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildKey
// ---------------------------------------------------------------------------
describe('buildKey', () => {
  it('same input produces same key', () => {
    const req = makeCanonical();
    const key1 = responseCache.buildKey('team_1', req);
    const key2 = responseCache.buildKey('team_1', req);
    expect(key1).toBe(key2);
  });

  it('different team produces different key', () => {
    const req = makeCanonical();
    const key1 = responseCache.buildKey('team_1', req);
    const key2 = responseCache.buildKey('team_2', req);
    expect(key1).not.toBe(key2);
  });

  it('different provider produces different key for the same canonical request', () => {
    const req = makeCanonical();
    const key1 = responseCache.buildKey('team_1', req, 'openai');
    const key2 = responseCache.buildKey('team_1', req, 'azure');
    expect(key1).not.toBe(key2);
  });

  it('key changes with response_format and tool_choice', () => {
    const base = makeCanonical({ response_format: { type: 'json_object' } as any, tool_choice: 'auto' as any });
    const changedFormat = makeCanonical({ response_format: { type: 'text' } as any, tool_choice: 'auto' as any });
    const changedToolChoice = makeCanonical({ response_format: { type: 'json_object' } as any, tool_choice: 'none' as any });

    const k1 = responseCache.buildKey('team_1', base);
    const k2 = responseCache.buildKey('team_1', changedFormat);
    const k3 = responseCache.buildKey('team_1', changedToolChoice);

    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('key changes with provider params that affect output', () => {
    const base = makeCanonical({ provider_params: { top_p: 0.8 } });
    const changedTopP = makeCanonical({ provider_params: { top_p: 0.2 } });
    const changedStop = makeCanonical({ provider_params: { top_p: 0.8, stop: ['END'] } });

    const k1 = responseCache.buildKey('team_1', base);
    const k2 = responseCache.buildKey('team_1', changedTopP);
    const k3 = responseCache.buildKey('team_1', changedStop);

    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('key changes with reasoning_effort (RSH-79 — must not replay low for high)', () => {
    const low = makeCanonical({ temperature: 0, reasoning_effort: 'low' });
    const high = makeCanonical({ temperature: 0, reasoning_effort: 'high' });
    const none = makeCanonical({ temperature: 0 });

    expect(responseCache.buildKey('team_1', low)).not.toBe(responseCache.buildKey('team_1', high));
    expect(responseCache.buildKey('team_1', low)).not.toBe(responseCache.buildKey('team_1', none));
  });

  it('key changes with thinking_budget_tokens (RSH-79)', () => {
    const small = makeCanonical({ temperature: 0, thinking_budget_tokens: 1024 });
    const large = makeCanonical({ temperature: 0, thinking_budget_tokens: 8192 });

    expect(responseCache.buildKey('team_1', small)).not.toBe(responseCache.buildKey('team_1', large));
  });

  it('key changes with Gemini thinking_level', () => {
    const low = makeCanonical({ temperature: 0, thinking_level: 'low' });
    const high = makeCanonical({ temperature: 0, thinking_level: 'high' });
    expect(responseCache.buildKey('team_1', low)).not.toBe(responseCache.buildKey('team_1', high));
  });
});

// ---------------------------------------------------------------------------
// get / set
// ---------------------------------------------------------------------------
describe('get / set', () => {
  it('returns stored entry', () => {
    responseCache.set('key_1', cacheEntry);
    const result = responseCache.get('key_1');
    expect(result).not.toBeNull();
    expect(result!.body).toEqual(cacheEntry.body);
    expect(result!.usage).toEqual(cacheEntry.usage);
  });

  it('returns null for expired entry', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    responseCache.set('key_exp', cacheEntry);

    // Expire entry beyond default 5-minute TTL.
    nowSpy.mockReturnValue(1_000 + 6 * 60 * 1000);
    const result = responseCache.get('key_exp');
    expect(result).toBeNull();

    nowSpy.mockRestore();
  });

  it('updates recency on get and preserves hot key under eviction', () => {
    // Fill cache to capacity.
    for (let i = 0; i < 2000; i++) {
      responseCache.set(`k_${i}`, { ...cacheEntry, body: { i } });
    }

    // Access oldest key to make it most-recent.
    expect(responseCache.get('k_0')).not.toBeNull();

    // Trigger single eviction.
    responseCache.set('k_new', { ...cacheEntry, body: { i: 'new' } });

    // k_1 should be evicted as oldest; k_0 should survive due to recency refresh.
    expect(responseCache.get('k_1')).toBeNull();
    expect(responseCache.get('k_0')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// invalidateTeam
// ---------------------------------------------------------------------------
describe('invalidateTeam', () => {
  it('removes entries for the requested team', () => {
    const req = makeCanonical({ temperature: 0 });
    const key = responseCache.buildKey('team_a', req, 'openai');

    responseCache.set(key, { ...cacheEntry, teamId: 'team_a', provider: 'openai' });
    responseCache.invalidateTeam('team_a');

    expect(responseCache.get(key)).toBeNull();
  });

  it('does not remove entries for other teams', () => {
    const req = makeCanonical({ temperature: 0 });
    const teamAKey = responseCache.buildKey('team_a', req, 'openai');
    const teamBKey = responseCache.buildKey('team_b', req, 'openai');

    responseCache.set(teamAKey, { ...cacheEntry, teamId: 'team_a', provider: 'openai' });
    responseCache.set(teamBKey, { ...cacheEntry, teamId: 'team_b', provider: 'openai' });

    responseCache.invalidateTeam('team_a');

    expect(responseCache.get(teamAKey)).toBeNull();
    expect(responseCache.get(teamBKey)).not.toBeNull();
  });

  it('removes only the requested provider when provider is supplied', () => {
    const req = makeCanonical({ temperature: 0 });
    const openAiKey = responseCache.buildKey('team_a', req, 'openai');
    const anthropicKey = responseCache.buildKey('team_a', req, 'anthropic');

    responseCache.set(openAiKey, { ...cacheEntry, teamId: 'team_a', provider: 'openai' });
    responseCache.set(anthropicKey, { ...cacheEntry, teamId: 'team_a', provider: 'anthropic' });

    responseCache.invalidateTeam('team_a', 'openai');

    expect(responseCache.get(openAiKey)).toBeNull();
    expect(responseCache.get(anthropicKey)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------
describe('LRU eviction', () => {
  it('evicts oldest entries when beyond max capacity', () => {
    // MAX_ENTRIES is 2000 — insert 2001 entries
    for (let i = 0; i < 2001; i++) {
      responseCache.set(`lru_${i}`, { ...cacheEntry, body: { i } });
    }
    // The first entry should have been evicted
    expect(responseCache.get('lru_0')).toBeNull();
    // The last entry should be present
    expect(responseCache.get('lru_2000')).not.toBeNull();
    expect(responseCache.stats.total).toBeLessThanOrEqual(2000);
  });
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
describe('stats', () => {
  it('returns correct size count', () => {
    expect(responseCache.stats.total).toBe(0);

    responseCache.set('s1', cacheEntry);
    responseCache.set('s2', cacheEntry);
    expect(responseCache.stats.total).toBe(2);
    expect(responseCache.stats.maxEntries).toBe(2000);
  });

  it('clear removes all entries', () => {
    responseCache.set('c1', cacheEntry);
    responseCache.set('c2', cacheEntry);
    expect(responseCache.stats.total).toBe(2);

    responseCache.clear();
    expect(responseCache.stats.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------
describe('shutdown', () => {
  it('clears the sweep timer without throwing', () => {
    // Create a second instance via the module — we test on the singleton
    // Just ensure shutdown is callable and idempotent
    expect(() => responseCache.shutdown()).not.toThrow();
  });
});
