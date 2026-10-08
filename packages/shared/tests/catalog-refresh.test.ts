import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDocsCatalogArtifact,
} from '../src/docs-catalog.js';
import { PRICING_TABLE, getModelPricing } from '../src/cost-tables.js';
import {
  generateCatalogRefresh,
  hashCatalogBytes,
  loadPreviousRefreshState,
  renderCurrentModels,
  renderFreshnessManifest,
  renderGeneratedModels,
  renderPricing,
  runCatalogRefresh,
  writeCatalogRefreshOutputs,
} from '../scripts/catalog-refresh.js';
import type {
  CatalogRefreshPrevious,
  CatalogSnapshot,
} from '../scripts/catalog-refresh-types.js';
import type { LiteLLMEntry } from '../scripts/litellm-source.js';

const generatedAt = '2026-08-26T12:00:00.000Z';
const sourceHash = 'fixture-source-hash';

function snapshot(entries: Record<string, LiteLLMEntry>, overrides: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    entries,
    source_url: 'https://example.test/litellm.json',
    source_hash: sourceHash,
    source_as_of: generatedAt,
    generated_at: generatedAt,
    ...overrides,
  };
}

const emptyPrevious: CatalogRefreshPrevious = {
  generatedModels: [],
  pricing: [],
};

function mistralEntry(overrides: LiteLLMEntry = {}): LiteLLMEntry {
  return {
    litellm_provider: 'mistral',
    mode: 'chat',
    input_cost_per_token: 0.15 / 1_000_000,
    output_cost_per_token: 0.6 / 1_000_000,
    max_input_tokens: 32_768,
    ...overrides,
  };
}

function modelEntry(model: string, input: number, output: number, context_window = 32_768): LiteLLMEntry {
  return {
    litellm_provider: 'mistral',
    mode: 'chat',
    input_cost_per_token: input / 1_000_000,
    output_cost_per_token: output / 1_000_000,
    max_input_tokens: context_window,
  };
}

describe('generateCatalogRefresh', () => {
  it('emits Mistral model and pricing from the same parsed snapshot', () => {
    const proposal = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-small-2603': mistralEntry() }),
      emptyPrevious,
    );

    expect(proposal.generatedModels).toContainEqual(expect.objectContaining({
      provider: 'mistral',
      canonical_name: 'mistral-small-2603',
      api_model_id: 'mistral-small-2603',
      explicit_only: true,
      auto_route: false,
      public: true,
      source: 'generated',
      source_url: 'https://example.test/litellm.json',
      source_hash: sourceHash,
      source_as_of: generatedAt,
    }));
    expect(proposal.pricing).toContainEqual(expect.objectContaining({
      provider: 'mistral',
      model: 'mistral-small-2603',
      input_per_million: 0.15,
      output_per_million: 0.6,
    }));
    expect(proposal.verdict.kind).toBe('review_required');
  });

  it('coalesces normalized duplicate chat rows when emitted pricing, context, and policy match', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'mistral/mistral-duplicate': mistralEntry(),
        'mistral-duplicate': mistralEntry({ deprecation_date: '2027-01-01' } as LiteLLMEntry),
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.verdict.reasons).not.toContain('duplicate_model_id:mistral:mistral-duplicate');
    expect(proposal.generatedModels.filter((model) => model.canonical_name === 'mistral-duplicate')).toHaveLength(1);
    expect(proposal.pricing.filter((row) => row.model === 'mistral-duplicate')).toHaveLength(1);
  });

  it('rejects conflicting normalized duplicate chat rows', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'mistral/mistral-duplicate': mistralEntry(),
        'mistral-duplicate': mistralEntry({ output_cost_per_token: 0.7 / 1_000_000 }),
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain('duplicate_model_id:mistral:mistral-duplicate');
  });

  it('quarantines cross-provider canonical collisions as review-required global-ID duplicates', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'dashscope/shared-canonical': mistralEntry({ litellm_provider: 'dashscope' }),
        'mistral/shared-canonical': mistralEntry(),
      }),
      emptyPrevious,
    );

    expect(proposal.generatedModels).toHaveLength(1);
    expect(proposal.generatedModels).toContainEqual(expect.objectContaining({
      provider: 'qwen',
      canonical_name: 'shared-canonical',
    }));
    expect(proposal.quarantined).toContainEqual({
      provider: 'mistral',
      model: 'shared-canonical',
      reason: 'duplicate_global_model_id:mistral:shared-canonical',
      kind: 'model',
    });
    expect(proposal.reviewReasons).toContain('duplicate_global_model_id:mistral:shared-canonical');
    expect(proposal.invalidReasons).not.toContain('duplicate_global_model_id:mistral:shared-canonical');
    expect(proposal.verdict.kind).toBe('review_required');
  });

  it('prefers a direct OpenAI bare GPT ID over Azure aliases and quarantines the loser', () => {
    const direct = {
      litellm_provider: 'openai',
      mode: 'chat',
      input_cost_per_token: 2 / 1_000_000,
      output_cost_per_token: 8 / 1_000_000,
      max_input_tokens: 128_000,
    };
    const azure = {
      ...direct,
      litellm_provider: 'azure',
      input_cost_per_token: 1 / 1_000_000,
      output_cost_per_token: 4 / 1_000_000,
    };

    const proposal = generateCatalogRefresh(
      snapshot({
        'azure/gpt-4o': azure,
        'gpt-4o': direct,
      }),
      emptyPrevious,
    );

    expect(proposal.generatedModels).toContainEqual(expect.objectContaining({
      provider: 'openai',
      canonical_name: 'gpt-4o',
    }));
    expect(proposal.generatedModels).not.toContainEqual(expect.objectContaining({
      provider: 'azure',
      canonical_name: 'gpt-4o',
    }));
    expect(proposal.quarantined).toContainEqual({
      provider: 'azure',
      model: 'gpt-4o',
      reason: 'duplicate_global_model_id:azure:gpt-4o',
      kind: 'model',
    });
  });

  it('rejects tokenless-versus-priced normalized chat duplicates before quarantine', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'mistral/tokenless-duplicate': {
          litellm_provider: 'mistral',
          mode: 'chat',
          max_input_tokens: 32_768,
        },
        'tokenless-duplicate': mistralEntry(),
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain('duplicate_model_id:mistral:tokenless-duplicate');
  });

  it.each(['image_generation', 'audio_transcription', 'audio_speech', 'embedding'])(
    'ignores unsupported %s rows before model and price validation',
    (mode) => {
      const proposal = generateCatalogRefresh(
        snapshot({ [`mistral/mistral-${mode}-2603`]: mistralEntry({ mode }) }),
        emptyPrevious,
      );

      expect(proposal.verdict.kind).toBe('safe');
      expect(proposal.generatedModels).toEqual([]);
      expect(proposal.pricing).toEqual([]);
    },
  );

  it.each(['audio', 'tts'])('rejects chat IDs with unsupported %s modality markers', (mode) => {
    const proposal = generateCatalogRefresh(
      snapshot({ [`mistral/mistral-${mode}-2603`]: mistralEntry({ mode: 'chat' }) }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain(`unsupported_modality:${mode}:mistral:mistral-${mode}-2603`);
  });

  it('ignores known size-and-step source-key wrappers before validating provider IDs', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        '50-steps/bedrock/amazon.nova-canvas-v1:0': mistralEntry({ mode: 'chat' }),
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('safe');
    expect(proposal.generatedModels).toEqual([]);
    expect(proposal.pricing).toEqual([]);
  });

  it('quarantines generated model rows whose existing adapter cannot send them', () => {
    const openaiCyber = {
      litellm_provider: 'openai',
      mode: 'chat',
      input_cost_per_token: 12.5 / 1_000_000,
      output_cost_per_token: 75 / 1_000_000,
      max_input_tokens: 400_000,
    };
    const bedrockOpenai = {
      litellm_provider: 'bedrock',
      mode: 'chat',
      input_cost_per_token: 4 / 1_000_000,
      output_cost_per_token: 20 / 1_000_000,
      max_input_tokens: 1_050_000,
    };
    const proposal = generateCatalogRefresh(
      snapshot({
        'openai/gpt-5.6-cyber': openaiCyber,
        'bedrock/global.openai.gpt-5.6-sol': bedrockOpenai,
      }),
      emptyPrevious,
    );

    expect(proposal.generatedModels).not.toContainEqual(expect.objectContaining({ canonical_name: 'gpt-5.6-cyber' }));
    expect(proposal.generatedModels).not.toContainEqual(expect.objectContaining({ canonical_name: 'global.openai.gpt-5.6-sol' }));
    expect(proposal.quarantined).toContainEqual({
      provider: 'bedrock',
      model: 'global.openai.gpt-5.6-sol',
      reason: 'unsupported_runtime_model:bedrock:global.openai.gpt-5.6-sol',
      kind: 'model',
    });
  });

  it('quarantines non-official Daybreak aliases instead of publishing them', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'openai/daybreak-blue-latest': {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 4 / 1_000_000,
          output_cost_per_token: 20 / 1_000_000,
          max_input_tokens: 1_050_000,
        },
        'openai/daybreak-red-latest': {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 12.5 / 1_000_000,
          output_cost_per_token: 75 / 1_000_000,
          max_input_tokens: 400_000,
        },
      }),
      emptyPrevious,
    );

    expect(proposal.generatedModels).toEqual([]);
    expect(proposal.quarantined).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openai',
        model: 'daybreak-blue-latest',
        reason: 'unsupported_model_alias:openai:daybreak-blue-latest',
        kind: 'model',
      }),
      expect.objectContaining({
        provider: 'openai',
        model: 'daybreak-red-latest',
        reason: 'unsupported_model_alias:openai:daybreak-red-latest',
        kind: 'model',
      }),
    ]));
  });

  it('quarantines discontinued Moonshot Kimi aliases before generated publication', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'moonshot/kimi-k2.5': {
          litellm_provider: 'moonshot',
          mode: 'chat',
          input_cost_per_token: 3 / 1_000_000,
          output_cost_per_token: 15 / 1_000_000,
          max_input_tokens: 262_144,
        },
        'moonshot/kimi-latest': {
          litellm_provider: 'moonshot',
          mode: 'chat',
          input_cost_per_token: 3 / 1_000_000,
          output_cost_per_token: 15 / 1_000_000,
          max_input_tokens: 262_144,
        },
        'moonshot/kimi-thinking-preview': {
          litellm_provider: 'moonshot',
          mode: 'chat',
          input_cost_per_token: 3 / 1_000_000,
          output_cost_per_token: 15 / 1_000_000,
          max_input_tokens: 262_144,
        },
      }),
      emptyPrevious,
    );

    expect(proposal.generatedModels).toEqual([]);
    expect(proposal.quarantined.filter((record) => record.provider === 'moonshot')).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'kimi-k2.5', reason: 'stale_model:moonshot:kimi-k2.5' }),
      expect.objectContaining({ model: 'kimi-latest', reason: 'stale_model:moonshot:kimi-latest' }),
      expect.objectContaining({ model: 'kimi-thinking-preview', reason: 'stale_model:moonshot:kimi-thinking-preview' }),
    ]));
  });

  it('keeps official Gemini latest aliases as generated explicit-only priced rows', () => {
    const entry = {
      litellm_provider: 'gemini',
      mode: 'chat',
      input_cost_per_token: 0.3 / 1_000_000,
      output_cost_per_token: 2.5 / 1_000_000,
      cache_read_input_token_cost: 0.03 / 1_000_000,
      max_input_tokens: 1_048_576,
    };
    const proposal = generateCatalogRefresh(
      snapshot({
        'gemini/gemini-flash-latest': entry,
        'gemini-flash-latest': entry,
        'gemini/gemini-flash-lite-latest': {
          ...entry,
          input_cost_per_token: 0.1 / 1_000_000,
          output_cost_per_token: 0.4 / 1_000_000,
          cache_read_input_token_cost: 0.01 / 1_000_000,
        },
        'gemini-flash-lite-latest': {
          ...entry,
          input_cost_per_token: 0.1 / 1_000_000,
          output_cost_per_token: 0.4 / 1_000_000,
          cache_read_input_token_cost: 0.01 / 1_000_000,
        },
      }),
      emptyPrevious,
    );

    expect(proposal.invalidReasons).toEqual([]);
    expect(proposal.generatedModels.filter((model) => model.provider === 'google')).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical_name: 'gemini-flash-latest', explicit_only: true, auto_route: false }),
      expect.objectContaining({ canonical_name: 'gemini-flash-lite-latest', explicit_only: true, auto_route: false }),
    ]));
    expect(proposal.pricing).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'google', model: 'gemini-flash-latest', input_per_million: 0.3 }),
      expect.objectContaining({ provider: 'google', model: 'gemini-flash-lite-latest', input_per_million: 0.1 }),
    ]));
  });

  it('quarantines removed Google preview IDs and keeps them out of generated models', () => {
    const previewIds = [
      'gemini-2.5-flash-lite-preview-06-17',
      'gemini-2.5-flash-lite-preview-09-2025',
      'gemini-2.5-flash-preview-09-2025',
      'gemini-3-flash-preview',
      'gemini-3.1-flash-lite-preview',
      'gemini-3.1-pro-preview',
      'gemini-3.1-pro-preview-customtools',
    ];
    const entries: Record<string, LiteLLMEntry> = {};
    for (const model of previewIds) {
      entries[`google/${model}`] = {
        litellm_provider: 'gemini',
        mode: 'chat',
        input_cost_per_token: 0.3 / 1_000_000,
        output_cost_per_token: 2.5 / 1_000_000,
        max_input_tokens: 1_048_576,
      };
    }

    const proposal = generateCatalogRefresh(snapshot(entries), emptyPrevious);

    expect(proposal.invalidReasons).toEqual([]);
    expect(proposal.generatedModels).toEqual([]);
    expect(proposal.quarantined).toEqual(expect.arrayContaining(
      previewIds.map((model) => expect.objectContaining({
        provider: 'google',
        model,
        reason: `unsupported_model_alias:google:${model}`,
        kind: 'model',
      })),
    ));
    for (const model of previewIds) {
      expect(proposal.verdict.reasons).toContain(`unsupported_model_alias:google:${model}`);
    }
  });

  it('quarantines chat rows with no token pricing instead of publishing zero-cost models', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'google/unpriced-chat': {
          litellm_provider: 'gemini',
          mode: 'chat',
          input_cost_per_token: 0,
          output_cost_per_token: 0,
          max_input_tokens: 32_768,
        },
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.invalidReasons).toEqual([]);
    expect(proposal.quarantined).toContainEqual({
      provider: 'google',
      model: 'unpriced-chat',
      reason: 'missing_token_pricing:google:unpriced-chat',
      kind: 'pricing',
    });
  });

  it('quarantines namespaced provider IDs that are unsafe for generated catalog records', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'together/meta-llama/unsafe-namespace': {
          litellm_provider: 'together_ai',
          mode: 'chat',
          input_cost_per_token: 1 / 1_000_000,
          output_cost_per_token: 2 / 1_000_000,
          max_input_tokens: 32_768,
        },
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.invalidReasons).toEqual([]);
    expect(proposal.quarantined).toContainEqual({
      provider: 'together',
      model: 'meta-llama/unsafe-namespace',
      reason: 'unsafe_model_id:together:meta-llama/unsafe-namespace',
      kind: 'model',
    });
  });

  it('quarantines generated chat rows without a context window', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'together/no-context': {
          litellm_provider: 'together_ai',
          mode: 'chat',
          input_cost_per_token: 1 / 1_000_000,
          output_cost_per_token: 2 / 1_000_000,
        },
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.invalidReasons).toEqual([]);
    expect(proposal.quarantined).toContainEqual({
      provider: 'together',
      model: 'no-context',
      reason: 'missing_context_window:together:no-context',
      kind: 'context',
    });
  });

  it('rejects unsafe model IDs before rendering generated source', () => {
    const unsafeId = 'mistral/bad"model';
    const proposal = generateCatalogRefresh(
      snapshot({ [unsafeId]: mistralEntry() }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain('unsafe_model_id:mistral:bad"model');
  });

  it('reports removed generated models as review-required', () => {
    const previous = {
      generatedModels: [
        {
          provider: 'mistral' as const,
          canonical_name: 'mistral-removed',
          api_model_id: 'mistral-removed',
          context_window: 32_768,
          source: 'generated' as const,
          public: true as const,
          explicit_only: true as const,
          auto_route: false as const,
          source_url: 'https://example.test/litellm.json',
          source_hash: 'old-hash',
          source_as_of: '2026-08-19T12:00:00.000Z',
        },
      ],
      pricing: [
        { provider: 'mistral', model: 'mistral-removed', input_per_million: 1, output_per_million: 2 },
      ],
    } satisfies CatalogRefreshPrevious;

    const proposal = generateCatalogRefresh(snapshot({}), previous);

    expect(proposal.removed).toContainEqual({ provider: 'mistral', model: 'mistral-removed' });
    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.verdict.reasons).toContain('model_removed:mistral:mistral-removed');
  });
  it('records prior-only pricing rows as removals requiring review', () => {
    const proposal = generateCatalogRefresh(
      snapshot({}),
      {
        pricing: [{ provider: 'mistral', model: 'mistral-pricing-removed', input_per_million: 1, output_per_million: 2 }],
      },
    );

    expect(proposal.removed).toContainEqual({ provider: 'mistral', model: 'mistral-pricing-removed' });
    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.verdict.reasons).toContain(
      'pricing_removed:mistral:mistral-pricing-removed',
    );
  });

  it('keeps a 25% price increase safe when no other review signal exists', () => {
    const previous = {
      generatedModels: [
        {
          provider: 'mistral' as const,
          canonical_name: 'mistral-price-boundary',
          api_model_id: 'mistral-price-boundary',
          context_window: 32_768,
          source: 'generated' as const,
          public: true as const,
          explicit_only: true as const,
          auto_route: false as const,
          source_url: 'https://example.test/litellm.json',
          source_hash: sourceHash,
          source_as_of: generatedAt,
        },
      ],
      pricing: [{ provider: 'mistral', model: 'mistral-price-boundary', input_per_million: 1, output_per_million: 2, cache_write_per_million: 0 }],
    } satisfies CatalogRefreshPrevious;

    const proposal = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-price-boundary': modelEntry('mistral-price-boundary', 1.25, 2.5) }),
      previous,
    );

    expect(proposal.priceDeltas).toContainEqual(expect.objectContaining({
      provider: 'mistral',
      model: 'mistral-price-boundary',
      input: 0.25,
      output: 0.25,
    }));
    expect(proposal.verdict.kind).toBe('safe');
  });

  it('requires review for a price change above 25%', () => {
    const previous = {
      generatedModels: [],
      pricing: [{ provider: 'mistral', model: 'mistral-price-large', input_per_million: 1, output_per_million: 2 }],
    } satisfies CatalogRefreshPrevious;

    const proposal = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-price-large': modelEntry('mistral-price-large', 1.26, 2) }),
      previous,
    );

    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.verdict.reasons).toContain('price_delta_over_25_percent:mistral:mistral-price-large:input');
  });

  it('surfaces long-tier price changes in deltas and requires review', () => {
    const model = 'gpt-5.6-long-delta';
    const previous = {
      generatedModels: [{
        provider: 'openai' as const,
        canonical_name: model,
        api_model_id: model,
        context_window: 1_000_000,
        source: 'generated' as const,
        public: true as const,
        explicit_only: true as const,
        auto_route: false as const,
        source_url: 'https://example.test/litellm.json',
        source_hash: sourceHash,
        source_as_of: generatedAt,
      }],
      pricing: [{
        provider: 'openai',
        model,
        input_per_million: 1,
        output_per_million: 2,
        cache_read_per_million: 0.1,
        cache_write_per_million: 1.25,
        input_per_million_above_272k: 1,
        output_per_million_above_272k: 1,
        cache_read_per_million_above_272k: 1,
        cache_write_per_million_above_272k: 1,
      }],
    } satisfies CatalogRefreshPrevious;
    const proposal = generateCatalogRefresh(
      snapshot({
        [`openai/${model}`]: {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 1 / 1_000_000,
          output_cost_per_token: 2 / 1_000_000,
          cache_read_input_token_cost: 0.1 / 1_000_000,
          cache_creation_input_token_cost: 1.25 / 1_000_000,
          input_cost_per_token_above_272k_tokens: 1.26 / 1_000_000,
          output_cost_per_token_above_272k_tokens: 1.26 / 1_000_000,
          cache_read_input_token_cost_above_272k_tokens: 1.26 / 1_000_000,
          cache_creation_input_token_cost_above_272k_tokens: 1.26 / 1_000_000,
          max_input_tokens: 1_000_000,
        },
      }),
      previous,
    );

    expect(proposal.priceDeltas).toContainEqual(expect.objectContaining({
      provider: 'openai',
      model,
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
    }));
    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.verdict.reasons).toEqual(expect.arrayContaining([
      `price_delta_over_25_percent:openai:${model}:input_above_272k`,
      `price_delta_over_25_percent:openai:${model}:output_above_272k`,
      `price_delta_over_25_percent:openai:${model}:cache_read_above_272k`,
      `price_delta_over_25_percent:openai:${model}:cache_write_above_272k`,
    ]));
  });

  it('surfaces long-tier rate additions and removals in the manifest', () => {
    const removedModel = 'gpt-5.6-long-removed';
    const addedModel = 'gpt-5.6-long-added';
    const previous = {
      pricing: [
        {
          provider: 'openai',
          model: removedModel,
          input_per_million: 1,
          output_per_million: 2,
          input_per_million_above_272k: 1,
          output_per_million_above_272k: 2,
          cache_read_per_million_above_272k: 0.1,
          cache_write_per_million_above_272k: 1.25,
        },
        {
          provider: 'openai',
          model: addedModel,
          input_per_million: 1,
          output_per_million: 2,
        },
      ],
    } satisfies CatalogRefreshPrevious;
    const proposal = generateCatalogRefresh(
      snapshot({
        [`openai/${removedModel}`]: {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 1 / 1_000_000,
          output_cost_per_token: 2 / 1_000_000,
          max_input_tokens: 1_000_000,
        },
        [`openai/${addedModel}`]: {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 1 / 1_000_000,
          output_cost_per_token: 2 / 1_000_000,
          input_cost_per_token_above_272k_tokens: 1.5 / 1_000_000,
          output_cost_per_token_above_272k_tokens: 3 / 1_000_000,
          cache_read_input_token_cost_above_272k_tokens: 0.15 / 1_000_000,
          cache_creation_input_token_cost_above_272k_tokens: 1.875 / 1_000_000,
          max_input_tokens: 1_000_000,
        },
      }),
      previous,
    );

    expect(proposal.priceDeltas).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'openai',
        model: removedModel,
        previous_input_above_272k: 1,
        next_input_above_272k: undefined,
        previous_output_above_272k: 2,
        next_output_above_272k: undefined,
        previous_cache_read_above_272k: 0.1,
        next_cache_read_above_272k: undefined,
        previous_cache_write_above_272k: 1.25,
        next_cache_write_above_272k: undefined,
      }),
      expect.objectContaining({
        provider: 'openai',
        model: addedModel,
        previous_input_above_272k: undefined,
        next_input_above_272k: 1.5,
        previous_output_above_272k: undefined,
        next_output_above_272k: 3,
        previous_cache_read_above_272k: undefined,
        next_cache_read_above_272k: 0.15,
        previous_cache_write_above_272k: undefined,
        next_cache_write_above_272k: 1.875,
      }),
    ]));
    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.verdict.reasons).toEqual(expect.arrayContaining([
      `price_delta_missing_bound:openai:${removedModel}:input_above_272k`,
      `price_delta_missing_bound:openai:${removedModel}:output_above_272k`,
      `price_delta_missing_bound:openai:${removedModel}:cache_read_above_272k`,
      `price_delta_missing_bound:openai:${removedModel}:cache_write_above_272k`,
      `price_delta_missing_bound:openai:${addedModel}:input_above_272k`,
      `price_delta_missing_bound:openai:${addedModel}:output_above_272k`,
      `price_delta_missing_bound:openai:${addedModel}:cache_read_above_272k`,
      `price_delta_missing_bound:openai:${addedModel}:cache_write_above_272k`,
    ]));
  });

  it('treats a previous zero price as a review transition before dividing', () => {
    const previous = {
      generatedModels: [],
      pricing: [{ provider: 'mistral', model: 'mistral-zero-transition', input_per_million: 0, output_per_million: 2 }],
    } satisfies CatalogRefreshPrevious;

    const proposal = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-zero-transition': modelEntry('mistral-zero-transition', 1, 2) }),
      previous,
    );

    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.verdict.reasons).toContain('price_zero_transition:mistral:mistral-zero-transition:input');
  });

  it('rejects a current zero price as invalid', () => {
    const proposal = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-zero-price': modelEntry('mistral-zero-price', 0, 2) }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain('invalid_price:mistral:mistral-zero-price:input');
  });

  it.each([
    ['cache_read_input_token_cost', -0.01, 'cache_read'],
    ['cache_creation_input_token_cost', -0.01, 'cache_write'],
    ['cache_creation_input_token_cost', Number.NaN, 'cache_write'],
    ['cache_read_input_token_cost', Number.POSITIVE_INFINITY, 'cache_read'],
  ] as const)('rejects invalid %s values before emitting a proposal', (field, value, outputField) => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'mistral/mistral-invalid-cache-rate': mistralEntry({ [field]: value }),
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain(
      `invalid_cache_rate:mistral:mistral-invalid-cache-rate:${outputField}`,
    );
  });

  it.each([
    ['input_cost_per_token_above_272k_tokens', 0, 'invalid_price', 'input_above_272k'],
    ['input_cost_per_token_above_272k_tokens', -0.01, 'invalid_price', 'input_above_272k'],
    ['input_cost_per_token_above_272k_tokens', Number.NaN, 'invalid_price', 'input_above_272k'],
    ['input_cost_per_token_above_272k_tokens', Number.POSITIVE_INFINITY, 'invalid_price', 'input_above_272k'],
    ['output_cost_per_token_above_272k_tokens', 0, 'invalid_price', 'output_above_272k'],
    ['output_cost_per_token_above_272k_tokens', -0.01, 'invalid_price', 'output_above_272k'],
    ['output_cost_per_token_above_272k_tokens', Number.NaN, 'invalid_price', 'output_above_272k'],
    ['output_cost_per_token_above_272k_tokens', Number.POSITIVE_INFINITY, 'invalid_price', 'output_above_272k'],
    ['cache_read_input_token_cost_above_272k_tokens', -0.01, 'invalid_cache_rate', 'cache_read_above_272k'],
    ['cache_read_input_token_cost_above_272k_tokens', Number.NaN, 'invalid_cache_rate', 'cache_read_above_272k'],
    ['cache_read_input_token_cost_above_272k_tokens', Number.POSITIVE_INFINITY, 'invalid_cache_rate', 'cache_read_above_272k'],
    ['cache_creation_input_token_cost_above_272k_tokens', -0.01, 'invalid_cache_rate', 'cache_write_above_272k'],
    ['cache_creation_input_token_cost_above_272k_tokens', Number.NaN, 'invalid_cache_rate', 'cache_write_above_272k'],
    ['cache_creation_input_token_cost_above_272k_tokens', Number.POSITIVE_INFINITY, 'invalid_cache_rate', 'cache_write_above_272k'],
  ] as const)(
    'rejects invalid long-tier %s values before emission',
    (field, value, reasonType, outputField) => {
      const proposal = generateCatalogRefresh(
        snapshot({
          'mistral/mistral-invalid-long-rate': mistralEntry({ [field]: value }),
        }),
        emptyPrevious,
      );

      expect(proposal.verdict.kind).toBe('invalid');
      expect(proposal.verdict.reasons).toContain(
        `${reasonType}:mistral:mistral-invalid-long-rate:${outputField}`,
      );
      expect(proposal.generatedModels).toEqual([]);
      expect(proposal.pricing).toEqual([]);
    },
  );

  it('accepts zero long-tier cache rates while requiring positive long-tier token rates', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'mistral/mistral-zero-long-cache': mistralEntry({
          input_cost_per_token_above_272k_tokens: 0.2 / 1_000_000,
          output_cost_per_token_above_272k_tokens: 0.8 / 1_000_000,
          cache_read_input_token_cost_above_272k_tokens: 0,
          cache_creation_input_token_cost_above_272k_tokens: 0,
        }),
      }),
      emptyPrevious,
    );

    expect(proposal.invalidReasons).toEqual([]);
    expect(proposal.pricing).toContainEqual(expect.objectContaining({
      provider: 'mistral',
      model: 'mistral-zero-long-cache',
      input_per_million_above_272k: 0.2,
      output_per_million_above_272k: 0.8,
      cache_read_per_million_above_272k: 0,
      cache_write_per_million_above_272k: 0,
    }));
  });

  it('rejects a positive long-tier source rate that rounds to zero on emission', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'mistral/mistral-underflow-long-rate': mistralEntry({
          input_cost_per_token_above_272k_tokens: Number.MIN_VALUE,
        }),
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain(
      'invalid_price:mistral:mistral-underflow-long-rate:input_above_272k',
    );
    expect(proposal.pricing).toEqual([]);
  });

  it('keeps invalid long-tier pricing dominant over review-required additions', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'mistral/mistral-valid-added': mistralEntry(),
        'mistral/mistral-invalid-long-dominant': mistralEntry({
          input_cost_per_token_above_272k_tokens: 0,
        }),
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain(
      'invalid_price:mistral:mistral-invalid-long-dominant:input_above_272k',
    );
    expect(proposal.verdict.reasons).toContain(
      'missing_second_source_evidence:mistral:mistral-valid-added',
    );
  });

  it('validates cache rates before a curated pricing row can bypass generation checks', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'openai/gpt-5.5': {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 5 / 1_000_000,
          output_cost_per_token: 30 / 1_000_000,
          cache_read_input_token_cost: -0.01,
          max_input_tokens: 1_000_000,
        },
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('invalid');
    expect(proposal.verdict.reasons).toContain('invalid_cache_rate:openai:gpt-5.5:cache_read');
  });

  it('keeps unknown cache policy as review-required quarantine', () => {
    const proposal = generateCatalogRefresh(
      snapshot({
        'bedrock/meta.llama3-catalog-freshness': {
          litellm_provider: 'bedrock',
          mode: 'chat',
          input_cost_per_token: 1 / 1_000_000,
          output_cost_per_token: 2 / 1_000_000,
          max_input_tokens: 32_768,
        },
      }),
      emptyPrevious,
    );

    expect(proposal.verdict.kind).toBe('review_required');
    expect(proposal.verdict.reasons).toContain(
      'unreviewed_cache_write_policy:bedrock:meta.llama3-catalog-freshness',
    );
  });

  it('requires review when cache policy semantics change despite equal emitted rates', () => {
    const model = 'qwen3.8-max';
    const entry = {
      litellm_provider: 'dashscope',
      mode: 'chat',
      input_cost_per_token: 2 / 1_000_000,
      output_cost_per_token: 6 / 1_000_000,
      cache_creation_input_token_cost: 2.5 / 1_000_000,
      max_input_tokens: 1_000_000,
    };
    const previous = {
      generatedModels: [{
        provider: 'qwen' as const,
        canonical_name: model,
        api_model_id: model,
        context_window: 1_000_000,
        source: 'generated' as const,
        public: true as const,
        explicit_only: true as const,
        auto_route: false as const,
        source_url: 'https://example.test/litellm.json',
        source_hash: sourceHash,
        source_as_of: generatedAt,
      }],
      pricing: [{
        provider: 'qwen',
        model,
        input_per_million: 2,
        output_per_million: 6,
        cache_write_per_million: 2.5,
      }],
      cachePolicies: [{
        provider: 'qwen',
        model,
        kind: 'rate' as const,
        per_million: 2.5,
        rule_version: 'catalog-refresh-v1',
      }],
    } satisfies CatalogRefreshPrevious;

    const proposal = generateCatalogRefresh(snapshot({ [`dashscope/${model}`]: entry }), previous);

    expect(proposal.priceDeltas).toEqual([]);
    expect(proposal.reviewReasons).toContain(`cache_policy_transition:qwen:${model}`);
    expect(proposal.verdict.kind).toBe('review_required');
  });

  it('treats an unchanged prior quarantine and cache policy as an accepted baseline', () => {
    const model = 'meta.llama3-catalog-freshness';
    const reason = `unreviewed_cache_write_policy:bedrock:${model}`;
    const previous = {
      quarantined: [{
        provider: 'bedrock',
        model,
        reason,
        kind: 'cache_policy' as const,
      }],
      cachePolicies: [{
        provider: 'bedrock',
        model,
        kind: 'unknown' as const,
        reason,
        rule_version: 'catalog-refresh-v1',
      }],
    } satisfies CatalogRefreshPrevious;

    const proposal = generateCatalogRefresh(snapshot({
      [`bedrock/${model}`]: {
        litellm_provider: 'bedrock',
        mode: 'chat',
        input_cost_per_token: 1 / 1_000_000,
        output_cost_per_token: 2 / 1_000_000,
        max_input_tokens: 32_768,
      },
    }), previous);

    expect(proposal.quarantined).toContainEqual(previous.quarantined[0]);
    expect(proposal.verdict).toEqual({ kind: 'safe', reasons: [] });
  });

  it('renders generated models and manifest deterministically', () => {
    const proposal = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-small-2603': mistralEntry() }),
      emptyPrevious,
    );

    expect(renderGeneratedModels(proposal.generatedModels)).toBe(
      renderGeneratedModels([...proposal.generatedModels].reverse()),
    );
    expect(renderFreshnessManifest(proposal.manifest)).toBe(
      renderFreshnessManifest(JSON.parse(JSON.stringify(proposal.manifest))),
    );
  });
  it('renders generated bytes using locale-independent ordering and long-tier pricing fields', () => {
    const rendered = renderPricing(
      [
        { provider: 'mistral', model: 'a-model', input_per_million: 1, output_per_million: 2 },
        {
          provider: 'mistral',
          model: 'Z-model',
          input_per_million: 1,
          output_per_million: 2,
          input_per_million_above_272k: 3,
          output_per_million_above_272k: 4,
          cache_read_per_million_above_272k: 0.3,
          cache_write_per_million_above_272k: 3.75,
        },
      ],
      'https://example.test/litellm.json',
      generatedAt,
    );

    expect(rendered.indexOf('\"Z-model\"')).toBeLessThan(rendered.indexOf('\"a-model\"'));
    expect(rendered).toContain('input_per_million_above_272k: 3');
    expect(rendered).toContain('output_per_million_above_272k: 4');
    expect(rendered).toContain('cache_read_per_million_above_272k: 0.3');
    expect(rendered).toContain('cache_write_per_million_above_272k: 3.75');
  });

  it('does not replace committed outputs when a refresh is invalid', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));
    const oldModels = 'old generated models\n';
    const oldManifest = 'old manifest\n';
    const oldPricing = 'old pricing\n';
    const oldCurrentModels = 'old current models\n';
    const oldDocsCatalog = 'old docs catalog\n';
    const modelsPath = join(outDir, 'generated-model-catalog.ts');
    const manifestPath = join(outDir, 'catalog-freshness.generated.ts');
    const pricingPath = join(outDir, 'litellm-pricing.generated.ts');
    const currentModelsPath = join(outDir, 'current-models.generated.ts');
    const docsCatalogPath = join(outDir, 'docs-catalog.generated.json');
    writeFileSync(modelsPath, oldModels);
    writeFileSync(manifestPath, oldManifest);
    writeFileSync(pricingPath, oldPricing);
    writeFileSync(currentModelsPath, oldCurrentModels);
    writeFileSync(docsCatalogPath, oldDocsCatalog);

    const invalid = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-audio': mistralEntry({ mode: 'chat' }) }),
      emptyPrevious,
    );

    expect(() => writeCatalogRefreshOutputs(invalid, outDir)).toThrow(/invalid/i);
    expect(readFileSync(modelsPath, 'utf8')).toBe(oldModels);
    expect(readFileSync(manifestPath, 'utf8')).toBe(oldManifest);
    expect(readFileSync(pricingPath, 'utf8')).toBe(oldPricing);
    expect(readFileSync(currentModelsPath, 'utf8')).toBe(oldCurrentModels);
    expect(readFileSync(docsCatalogPath, 'utf8')).toBe(oldDocsCatalog);
  });
  it('replaces all generated artifacts together for a valid review proposal', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));
    const proposal = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-small-2603': mistralEntry() }),
      emptyPrevious,
    );

    writeCatalogRefreshOutputs(proposal, outDir);

    expect(readFileSync(join(outDir, 'generated-model-catalog.ts'), 'utf8')).toContain(
      'GENERATED_MODEL_CATALOG',
    );
    expect(readFileSync(join(outDir, 'litellm-pricing.generated.ts'), 'utf8')).toContain(
      'LITELLM_GENERATED_PRICING',
    );
    expect(readFileSync(join(outDir, 'catalog-freshness.generated.ts'), 'utf8')).toContain(
      'CATALOG_FRESHNESS_MANIFEST',
    );
    expect(readFileSync(join(outDir, 'current-models.generated.ts'), 'utf8')).toContain(
      'CURRENT_MODEL_FIXTURE',
    );
    const docsCatalogBytes = readFileSync(join(outDir, 'docs-catalog.generated.json'), 'utf8');
    const proposalPricing = new Map(proposal.pricing.map((entry) => [`${entry.provider}:${entry.model}`, entry] as const));
    const installedPricing = new Map(PRICING_TABLE.map((entry) => [`${entry.provider}:${entry.model}`, entry] as const));
    const optionalPricingFields = [
      'cache_read_per_million',
      'cache_write_per_million',
      'input_per_million_above_272k',
      'output_per_million_above_272k',
      'cache_read_per_million_above_272k',
      'cache_write_per_million_above_272k',
    ] as const;
    for (const entry of proposalPricing.values()) {
      const key = `${entry.provider}:${entry.model}`;
      const curated = installedPricing.get(key);
      if (!curated) {
        installedPricing.set(key, entry);
        continue;
      }
      const merged = { ...curated };
      for (const field of optionalPricingFields) {
        if (merged[field] === undefined && entry[field] !== undefined) merged[field] = entry[field];
      }
      installedPricing.set(key, merged);
    }
    const proposalArtifact = buildDocsCatalogArtifact({
      generatedModels: proposal.generatedModels,
      pricingLookup: (provider, model) => installedPricing.get(`${provider}:${model}`) ?? null,
      generatedAt: proposal.manifest.generated_at,
      sourceHash: proposal.manifest.source_hash,
    });
    expect(docsCatalogBytes).toBe(`${JSON.stringify(proposalArtifact, null, 2)}\n`);
    expect(JSON.parse(docsCatalogBytes)).toEqual(proposalArtifact);
  });
  it('keeps curated pricing precedence when building the proposal artifact', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));
    const proposal = generateCatalogRefresh(
      snapshot({
        'openai/gpt-5.6': {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 99 / 1_000_000,
          output_cost_per_token: 199 / 1_000_000,
          max_input_tokens: 1_050_000,
        },
      }),
      emptyPrevious,
    );

    writeCatalogRefreshOutputs(proposal, outDir);

    const artifact = JSON.parse(readFileSync(join(outDir, 'docs-catalog.generated.json'), 'utf8'));
    const current = getModelPricing('openai', 'gpt-5.6');
    expect(current).not.toBeNull();
    expect(artifact.models.find((model: { id: string }) => model.id === 'gpt-5.6')?.pricing.input)
      .toBe(String((current?.input_per_million ?? 0) / 1_000_000));
  });
  it('keeps installed outputs when best-effort backup cleanup fails', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));
    const modelsPath = join(outDir, 'generated-model-catalog.ts');
    const manifestPath = join(outDir, 'catalog-freshness.generated.ts');
    const pricingPath = join(outDir, 'litellm-pricing.generated.ts');
    writeFileSync(modelsPath, 'old models\n');
    writeFileSync(manifestPath, 'old manifest\n');
    writeFileSync(pricingPath, 'old pricing\n');
    const proposal = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-small-2603': mistralEntry() }),
      emptyPrevious,
    );
    const remove = vi.fn((path: string) => {
      if (path.includes('.bak-')) throw new Error('backup cleanup unavailable');
    });

    expect(() => writeCatalogRefreshOutputs(proposal, outDir, { remove })).not.toThrow();
    expect(remove).toHaveBeenCalled();
    expect(readFileSync(modelsPath, 'utf8')).toContain('mistral-small-2603');
    expect(readFileSync(manifestPath, 'utf8')).toContain('mistral-small-2603');
    expect(readFileSync(pricingPath, 'utf8')).toContain('mistral-small-2603');
  });
  it('fetches and parses one raw snapshot before writing every artifact', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      'mistral/mistral-small-2603': mistralEntry(),
    }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json', 'content-length': String(bytes.byteLength) }),
      arrayBuffer: async () => bytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));

    try {
      const proposal = await runCatalogRefresh({ outDir, generatedAt });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(proposal.manifest.source_hash).toBe(hashCatalogBytes(bytes));
      expect(readFileSync(join(outDir, 'generated-model-catalog.ts'), 'utf8')).toContain('mistral-small-2603');
      expect(readFileSync(join(outDir, 'litellm-pricing.generated.ts'), 'utf8')).toContain('mistral-small-2603');
      expect(readFileSync(join(outDir, 'catalog-freshness.generated.ts'), 'utf8')).toContain(hashCatalogBytes(bytes));
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('loads committed prior artifacts before classifying an empty valid snapshot', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));
    const prior = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-small-2603': mistralEntry() }),
      emptyPrevious,
    );
    writeCatalogRefreshOutputs(prior, outDir);
    expect(loadPreviousRefreshState(outDir).generatedModels).toHaveLength(1);

    const bytes = new TextEncoder().encode('{}');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json', 'content-length': String(bytes.byteLength) }),
      arrayBuffer: async () => bytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const next = await runCatalogRefresh({ outDir, generatedAt });
      expect(next.verdict.kind).toBe('review_required');
      expect(next.removed).toContainEqual({ provider: 'mistral', model: 'mistral-small-2603' });
      expect(next.verdict.reasons).toContain('model_removed:mistral:mistral-small-2603');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('loads all long-tier pricing fields from prior generated artifacts', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));
    const pricing = [{
      provider: 'mistral',
      model: 'mistral-long-prior',
      input_per_million: 1,
      output_per_million: 2,
      cache_read_per_million: 0.1,
      cache_write_per_million: 1.25,
      input_per_million_above_272k: 3,
      output_per_million_above_272k: 4,
      cache_read_per_million_above_272k: 0.3,
      cache_write_per_million_above_272k: 5,
    }];
    writeFileSync(
      join(outDir, 'litellm-pricing.generated.ts'),
      renderPricing(pricing, 'https://example.test/litellm.json', generatedAt),
    );

    expect(loadPreviousRefreshState(outDir).pricing).toEqual(pricing);
  });

  it('loads prior cache-policy decisions and quarantines from the freshness manifest', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));
    const quarantine = {
      provider: 'bedrock',
      model: 'meta.llama3-prior',
      reason: 'unreviewed_cache_write_policy:bedrock:meta.llama3-prior',
      kind: 'cache_policy' as const,
    };
    const cachePolicy = {
      provider: 'bedrock',
      model: 'meta.llama3-prior',
      kind: 'unknown' as const,
      reason: quarantine.reason,
      rule_version: 'catalog-refresh-v1',
    };
    writeFileSync(
      join(outDir, 'catalog-freshness.generated.ts'),
      renderFreshnessManifest({
        schema_version: 1,
        generated_at: generatedAt,
        source_url: 'https://example.test/litellm.json',
        source_hash: sourceHash,
        previous_source_hash: null,
        added: [],
        changed: [],
        removed: [],
        quarantined: [quarantine],
        price_deltas: [],
        context_deltas: [],
        cache_policy: [cachePolicy],
        verdict: { kind: 'safe', reasons: [] },
      }),
    );

    expect(loadPreviousRefreshState(outDir)).toMatchObject({
      quarantined: [quarantine],
      cachePolicies: [cachePolicy],
    });
  });

  it('carries the committed prior source hash into the next manifest', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'catalog-refresh-'));
    const prior = generateCatalogRefresh(
      snapshot({ 'mistral/mistral-small-2603': mistralEntry() }, { source_hash: 'prior-hash' }),
      emptyPrevious,
    );
    writeCatalogRefreshOutputs(prior, outDir);
    const bytes = new TextEncoder().encode(JSON.stringify({
      'mistral/mistral-small-2603': mistralEntry({ output_cost_per_token: 0.7 / 1_000_000 }),
    }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json', 'content-length': String(bytes.byteLength) }),
      arrayBuffer: async () => bytes.buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const next = await runCatalogRefresh({ outDir, generatedAt });
      expect(next.manifest.previous_source_hash).toBe('prior-hash');
      expect(next.manifest.previous_source_hash).not.toBe(next.manifest.source_hash);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
