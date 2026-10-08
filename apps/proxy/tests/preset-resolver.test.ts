import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('../src/db/pool.js', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { invalidatePresetCache, resolvePreset } from '../src/presets/resolver.js';

beforeEach(() => {
  mockQuery.mockReset();
  invalidatePresetCache();
});

describe('resolvePreset', () => {
  it('resolves a team-scoped live preset and caches by team/ref', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        model: 'claude-opus-4-8',
        params: { temperature: 0.2, max_tokens: 1024 },
        system_prompt: 'You are concise.',
        provider_prefs: { data_collection: 'deny' },
      }],
    });

    await expect(resolvePreset('team_a', 'support-bot')).resolves.toEqual({
      model: 'claude-opus-4-8',
      params: { temperature: 0.2, max_tokens: 1024 },
      system_prompt: 'You are concise.',
      provider_prefs: { data_collection: 'deny' },
    });
    await expect(resolvePreset('team_a', 'support-bot')).resolves.toEqual(expect.objectContaining({
      model: 'claude-opus-4-8',
    }));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(String(mockQuery.mock.calls[0][0])).toContain('WHERE team_id = $1 AND slug = $2 AND enabled = true');
    expect(mockQuery.mock.calls[0][1]).toEqual(['team_a', 'support-bot']);
  });

  it('resolves a pinned version only when the parent preset is enabled', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        model: 'gpt-5.4',
        params: { top_p: 0.8 },
        system_prompt: null,
        provider_prefs: null,
      }],
    });

    await expect(resolvePreset('team_a', 'support-bot@2')).resolves.toEqual({
      model: 'gpt-5.4',
      params: { top_p: 0.8 },
      system_prompt: undefined,
      provider_prefs: undefined,
    });

    expect(String(mockQuery.mock.calls[0][0])).toContain('JOIN presets p ON p.id = pv.preset_id');
    expect(String(mockQuery.mock.calls[0][0])).toContain('p.enabled = true');
    expect(mockQuery.mock.calls[0][1]).toEqual(['team_a', 'support-bot', 2]);
  });

  it('returns null for malformed refs without hitting the database', async () => {
    await expect(resolvePreset('team_a', '../bad')).resolves.toBeNull();
    await expect(resolvePreset('team_a', 'bad@not-a-version')).resolves.toBeNull();
    await expect(resolvePreset('team_a', 'x'.repeat(65))).resolves.toBeNull();
    await expect(resolvePreset('team_a', 'support-bot@2147483648')).resolves.toBeNull();

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('preserves malformed stored provider preferences for request-time validation', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        model: 'gpt-5.4',
        params: {},
        system_prompt: null,
        provider_prefs: ['not-a-provider-preferences-object'],
      }],
    });

    await expect(resolvePreset('team_a', 'malformed-prefs')).resolves.toEqual({
      model: 'gpt-5.4',
      params: {},
      system_prompt: undefined,
      provider_prefs: ['not-a-provider-preferences-object'],
    });
  });

  it('caches misses and allows team-specific invalidation', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ model: 'gpt-5.4', params: {}, system_prompt: null, provider_prefs: null }] });

    await expect(resolvePreset('team_a', 'missing')).resolves.toBeNull();
    await expect(resolvePreset('team_a', 'missing')).resolves.toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);

    invalidatePresetCache('team_a');
    await expect(resolvePreset('team_a', 'missing')).resolves.toEqual(expect.objectContaining({ model: 'gpt-5.4' }));
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});
