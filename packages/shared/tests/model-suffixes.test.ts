import { describe, expect, it } from 'vitest';
import { parseModelSuffixes } from '../src/model-suffixes';

describe('parseModelSuffixes', () => {
  it('strips known suffixes from the right and maps :floor to price sort', () => {
    expect(parseModelSuffixes('gpt-5.4:floor:online')).toEqual({
      ok: true,
      model: 'gpt-5.4',
      suffixes: ['floor', 'online'],
      online: true,
      providerPreferences: { sort: 'price' },
    });
  });

  it('maps :nitro to throughput sort without forwarding the suffix', () => {
    expect(parseModelSuffixes('llama-3.1-70b:nitro')).toEqual({
      ok: true,
      model: 'llama-3.1-70b',
      suffixes: ['nitro'],
      online: false,
      providerPreferences: { sort: 'throughput' },
    });
  });

  it('leaves colon-bearing model prefixes intact when the trailing token is not a known suffix', () => {
    expect(parseModelSuffixes('ft:gpt-4.1-custom')).toEqual({
      ok: true,
      model: 'ft:gpt-4.1-custom',
      suffixes: [],
      online: false,
      providerPreferences: null,
    });
  });

  it('rejects conflicting optimization suffixes', () => {
    expect(parseModelSuffixes('gpt-5.4:floor:nitro')).toEqual({
      ok: false,
      reason: 'conflicting_model_suffixes',
    });
  });
});
