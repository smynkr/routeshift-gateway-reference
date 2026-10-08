import { describe, expect, it } from 'vitest';
import { classifyCatalogRefresh } from '../scripts/catalog-refresh-classifier.js';
import type {
  CatalogRefreshProposal,
  CatalogRefreshVerdict,
} from '../scripts/catalog-refresh-types.js';

function proposal(overrides: Partial<CatalogRefreshProposal> = {}): CatalogRefreshProposal {
  return {
    generatedModels: [],
    pricing: [],
    added: [],
    changed: [],
    removed: [],
    quarantined: [],
    priceDeltas: [],
    contextDeltas: [],
    invalidReasons: [],
    reviewReasons: [],
    manifest: {
      schema_version: 1,
      generated_at: '2026-08-26T12:00:00.000Z',
      source_url: 'https://example.test/litellm.json',
      source_hash: 'source-hash',
      previous_source_hash: null,
      added: [],
      changed: [],
      removed: [],
      quarantined: [],
      price_deltas: [],
      context_deltas: [],
      cache_policy: [],
      verdict: { kind: 'safe', reasons: [] },
    },
    verdict: { kind: 'safe', reasons: [] },
    ...overrides,
  };
}

describe('classifyCatalogRefresh', () => {
  it('returns safe with no reasons for an unchanged proposal', () => {
    expect(classifyCatalogRefresh(proposal())).toEqual({ kind: 'safe', reasons: [] });
  });

  it('invalid dominates review-required signals', () => {
    const verdict = classifyCatalogRefresh(proposal({
      invalidReasons: ['unsafe_model_id:mistral:bad"model'],
      reviewReasons: ['model_removed:mistral:old-model'],
    }));

    expect(verdict).toEqual({
      kind: 'invalid',
      reasons: ['unsafe_model_id:mistral:bad"model', 'model_removed:mistral:old-model'],
    });
  });

  it('review-required dominates an otherwise safe proposal', () => {
    expect(classifyCatalogRefresh(proposal({
      reviewReasons: ['missing_second_source_evidence:mistral:new-model'],
    }))).toEqual({
      kind: 'review_required',
      reasons: ['missing_second_source_evidence:mistral:new-model'],
    });
  });

  it('treats exactly 25% price and context deltas as safe', () => {
    expect(classifyCatalogRefresh(proposal({
      priceDeltas: [{ provider: 'mistral', model: 'mistral-boundary', input: 0.25, output: 0.25 }],
      contextDeltas: [{ provider: 'mistral', model: 'mistral-boundary', previous: 32_768, next: 40_960, delta: 0.25 }],
    }))).toEqual({ kind: 'safe', reasons: [] });
  });

  it('requires review for price and context deltas above 25%', () => {
    const verdict = classifyCatalogRefresh(proposal({
      priceDeltas: [{ provider: 'mistral', model: 'mistral-large-delta', input: 0.250001, output: 0 }],
      contextDeltas: [{ provider: 'mistral', model: 'mistral-large-delta', previous: 32_768, next: 40_961, delta: 0.25003 }],
    }));

    expect(verdict.kind).toBe('review_required');
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'price_delta_over_25_percent:mistral:mistral-large-delta:input',
      'context_delta_over_25_percent:mistral:mistral-large-delta',
    ]));
  });

  it('requires review for either direction of a zero price transition', () => {
    const verdict = classifyCatalogRefresh(proposal({
      priceDeltas: [
        { provider: 'mistral', model: 'mistral-zero', input: 1, output: 0, previous_input: 0, next_input: 1, previous_output: 2, next_output: 0 },
        { provider: 'mistral', model: 'mistral-zero-back', input: 0, output: 1, previous_input: 1, next_input: 0, previous_output: 0, next_output: 1 },
      ],
    }));

    expect(verdict.kind).toBe('review_required');
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'price_zero_transition:mistral:mistral-zero:input',
      'price_zero_transition:mistral:mistral-zero:output',
      'price_zero_transition:mistral:mistral-zero-back:input',
      'price_zero_transition:mistral:mistral-zero-back:output',
    ]));
  });

  it('requires review for removals and unknown cache policy', () => {
    const verdict = classifyCatalogRefresh(proposal({
      removed: [{ provider: 'mistral', model: 'mistral-removed' }],
      quarantined: [{ provider: 'bedrock', model: 'meta.llama3', reason: 'unreviewed_cache_write_policy:bedrock:meta.llama3' }],
    }));

    expect(verdict.kind).toBe('review_required');
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'model_removed:mistral:mistral-removed',
      'unreviewed_cache_write_policy:bedrock:meta.llama3',
    ]));
  });

  it('does not let a zero previous value produce Infinity or NaN', () => {
    const verdict = classifyCatalogRefresh(proposal({
      priceDeltas: [{
        provider: 'mistral',
        model: 'mistral-zero-base',
        input: 1,
        output: 0,
        previous_input: 0,
        next_input: 1,
        previous_output: 0,
        next_output: 0,
      }],
    }));

    expect(verdict.kind).toBe('review_required');
    expect(verdict.reasons).not.toContain(expect.stringContaining('NaN'));
    expect(verdict.reasons).not.toContain(expect.stringContaining('Infinity'));
  });
  it('keeps a decimal 0.15 to 0.1875 price change at the exact 25% boundary', () => {
    const verdict = classifyCatalogRefresh(proposal({
      priceDeltas: [{
        provider: 'mistral',
        model: 'mistral-decimal-boundary',
        input: 0.25,
        output: 0,
        previous_input: 0.15,
        next_input: 0.1875,
        previous_output: 2,
        next_output: 2,
      }],
    }));

    expect(verdict).toEqual({ kind: 'safe', reasons: [] });
  });

  it('recomputes context percentage from previous and next values', () => {
    const verdict = classifyCatalogRefresh(proposal({
      contextDeltas: [{
        provider: 'mistral',
        model: 'mistral-context-untrusted-delta',
        previous: 100,
        next: 126,
        delta: 0,
      }],
    }));

    expect(verdict.kind).toBe('review_required');
    expect(verdict.reasons).toContain('context_delta_over_25_percent:mistral:mistral-context-untrusted-delta');
  });

  it('makes negative and non-finite prices invalid before zero transitions', () => {
    const verdict = classifyCatalogRefresh(proposal({
      priceDeltas: [
        {
          provider: 'mistral',
          model: 'mistral-negative-price',
          input: 0,
          output: 0,
          previous_input: -1,
          next_input: 0,
          previous_output: 1,
          next_output: 1,
        },
        {
          provider: 'mistral',
          model: 'mistral-nonfinite-price',
          input: 0,
          output: 0,
          previous_input: Number.NaN,
          next_input: 0,
          previous_output: 1,
          next_output: 1,
        },
      ],
    }));

    expect(verdict.kind).toBe('invalid');
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'invalid_price:mistral:mistral-negative-price:input',
      'invalid_price:mistral:mistral-nonfinite-price:input',
    ]));
  });

  it('classifies over-25-percent changes in every long-tier pricing field', () => {
    const verdict = classifyCatalogRefresh(proposal({
      priceDeltas: [{
        provider: 'mistral',
        model: 'mistral-long-delta',
        input: 0,
        output: 0,
        input_above_272k: 0.26,
        output_above_272k: 0.26,
        cache_read_above_272k: 0.26,
        cache_write_above_272k: 0.26,
        previous_input_above_272k: 1,
        next_input_above_272k: 1.26,
        previous_output_above_272k: 1,
        next_output_above_272k: 1.26,
        previous_cache_read_above_272k: 1,
        next_cache_read_above_272k: 1.26,
        previous_cache_write_above_272k: 1,
        next_cache_write_above_272k: 1.26,
      }],
    }));

    expect(verdict.kind).toBe('review_required');
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'price_delta_over_25_percent:mistral:mistral-long-delta:input_above_272k',
      'price_delta_over_25_percent:mistral:mistral-long-delta:output_above_272k',
      'price_delta_over_25_percent:mistral:mistral-long-delta:cache_read_above_272k',
      'price_delta_over_25_percent:mistral:mistral-long-delta:cache_write_above_272k',
    ]));
  });

  it('requires review for long-tier additions, removals, and zero transitions', () => {
    const verdict = classifyCatalogRefresh(proposal({
      priceDeltas: [
        {
          provider: 'mistral',
          model: 'mistral-long-added',
          input: 0,
          output: 0,
          input_above_272k: 0,
          previous_input_above_272k: 1,
        },
        {
          provider: 'mistral',
          model: 'mistral-long-zero',
          input: 0,
          output: 0,
          cache_read_above_272k: 1,
          cache_write_above_272k: 1,
          previous_cache_read_above_272k: 2,
          next_cache_read_above_272k: 0,
          previous_cache_write_above_272k: 2,
          next_cache_write_above_272k: 0,
        },
      ],
    }));

    expect(verdict.kind).toBe('review_required');
    expect(verdict.reasons).toEqual(expect.arrayContaining([
      'price_delta_missing_bound:mistral:mistral-long-added:input_above_272k',
      'price_zero_transition:mistral:mistral-long-zero:cache_read_above_272k',
      'price_zero_transition:mistral:mistral-long-zero:cache_write_above_272k',
    ]));
  });
});
