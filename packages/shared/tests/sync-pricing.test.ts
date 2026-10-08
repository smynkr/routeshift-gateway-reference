import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCacheWritePolicy } from '../scripts/cache-write-policy.js';
import { toOutputEntry, toOutputEntryResult } from '../scripts/sync-pricing.js';
import type { LiteLLMEntry } from '../scripts/litellm-source.js';

describe('sync-pricing cache-write policy', () => {
  const chat = { mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } as const;

  const fixtureEntry = (provider: string, model: string): LiteLLMEntry => {
    const lower = model.toLowerCase();
    const inputPerMillion =
      provider === 'anthropic'
        ? 3
        : provider === 'bedrock' && lower.includes('gpt-5.6-sol')
          ? 5
          : lower.includes('gpt-5.6-terra')
            ? 2
            : lower.includes('gpt-5.6-sol')
              ? 4
              : lower.includes('gpt-5.4')
                ? 2.5
                : 1;
    return {
      ...chat,
      litellm_provider: provider,
      input_cost_per_token: inputPerMillion / 1_000_000,
      output_cost_per_token: 3 / 1_000_000,
      cache_creation_input_token_cost: (inputPerMillion * 1.25) / 1_000_000,
    };
  };

  it.each([
    ['openai', 'gpt-5.6-sol', 'input_multiplier', 5],
    ['openai', 'gpt-5.6-terra', 'input_multiplier', 2.5],
    ['bedrock', 'global.openai.gpt-5.6-sol', 'input_multiplier', 6.25],
    ['bedrock', 'openai.gpt-5.4', 'not_billed', 0],
    ['anthropic', 'claude-sonnet-4-6', 'rate', 3.75],
  ] as const)(
    '%s/%s emits reviewed cache-write semantics',
    (provider, model, kind, expectedPerMillion) => {
      const entry = fixtureEntry(provider, model);
      const policy = resolveCacheWritePolicy(provider, model, entry);
      expect(policy.kind).toBe(kind);
      const output = toOutputEntry(model, entry);
      expect(output?.cache_write_per_million).toBe(expectedPerMillion);
    },
  );

  it('charges Qwen3.8-Max cache writes at the official 1.25x input rate before Qwen no-write defaults', () => {
    const entry = {
      ...chat,
      litellm_provider: 'dashscope',
      input_cost_per_token: 2e-6,
      output_cost_per_token: 6e-6,
      cache_creation_input_token_cost: 2.5e-6,
    };
    expect(resolveCacheWritePolicy('qwen', 'qwen3.8-max', entry)).toEqual({
      kind: 'input_multiplier',
      multiplier: 1.25,
    });
    expect(toOutputEntry('dashscope/qwen3.8-max', entry)).toMatchObject({
      provider: 'qwen',
      model: 'qwen3.8-max',
      cache_write_per_million: 2.5,
    });
  });

  it('omits discontinued Moonshot K2 and latest aliases from generated pricing', () => {
    const entry = {
      ...chat,
      litellm_provider: 'moonshot',
      input_cost_per_token: 3e-6,
      output_cost_per_token: 15e-6,
    };
    expect(toOutputEntryResult('moonshot/kimi-k2.5', entry)).toBeNull();
    expect(toOutputEntryResult('moonshot/kimi-latest', entry)).toBeNull();
    expect(toOutputEntryResult('moonshot/kimi-thinking-preview', entry)).toBeNull();
  });

  it.each([
    ['azure/gpt-5.6-sol', 'gpt-5.6-sol'],
    ['azure/eu/gpt-5.6-sol', 'eu/gpt-5.6-sol'],
    ['azure/us/gpt-5.6-terra', 'us/gpt-5.6-terra'],
  ] as const)('quarantines Azure GPT-5.6 model %s without policy evidence', (modelKey, model) => {
    const entry = fixtureEntry('azure', model);
    expect(resolveCacheWritePolicy('azure', model, entry)).toEqual({
      kind: 'unknown',
      reason: 'azure_gpt_5_6_cache_write_policy_unverified',
    });
    expect(toOutputEntryResult(modelKey, entry)).toEqual({
      kind: 'quarantine',
      provider: 'azure',
      model,
      reason: 'azure_gpt_5_6_cache_write_policy_unverified',
    });
    expect(toOutputEntry(modelKey, entry)).toBeNull();
  });

  it('zeroes LiteLLM-modeled cache-creation rates for pre-GPT-5.6 openai (not a billable write class)', () => {
    // LiteLLM models cache_creation for openai as input x 1.25; OpenAI
    // models before GPT-5.6 have no separate cache-write class, so the
    // generated row must carry an EXPLICIT 0.
    const out = toOutputEntry('openai/gpt-5.5-luna', {
      ...chat,
      litellm_provider: 'openai',
      input_cost_per_token: 2e-7,
      output_cost_per_token: 1.2e-6,
      cache_creation_input_token_cost: 2.5e-7,
    });
    expect(out).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.5-luna',
      input_per_million: 0.2,
      output_per_million: 1.2,
      cache_write_per_million: 0,
    });
  });

  it('keeps real cache-write rates for anthropic and bedrock (Anthropic models)', () => {
    const anthropic = toOutputEntry('anthropic/claude-opus-4-6', {
      ...chat,
      litellm_provider: 'anthropic',
      input_cost_per_token: 5e-6,
      output_cost_per_token: 2.5e-5,
      cache_creation_input_token_cost: 6.25e-6,
    });
    expect(anthropic?.cache_write_per_million).toBe(6.25);

    const bedrock = toOutputEntry('bedrock/anthropic.claude-sonnet-5', {
      ...chat,
      litellm_provider: 'bedrock',
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      cache_creation_input_token_cost: 3.75e-6,
    });
    expect(bedrock?.cache_write_per_million).toBe(3.75);
  });

  it('zeroes cache-creation rates for OpenAI-family Bedrock models (no write fee pre-GPT-5.6)', () => {
    // LiteLLM models the 1.25x-input ratio on these rows too, but AWS bills
    // NO cache-write fee for OpenAI models on Bedrock — copying the modeled
    // ratio would overcharge every cache-write token.
    const openaiBedrock = toOutputEntry('bedrock/openai.gpt-4o', {
      ...chat,
      litellm_provider: 'bedrock',
      input_cost_per_token: 2.5e-6,
      output_cost_per_token: 1e-5,
      cache_creation_input_token_cost: 3.125e-6, // 1.25x input — must NOT be copied
    });
    expect(openaiBedrock?.cache_write_per_million).toBe(0);

    // Non-Anthropic, non-OpenAI families copy a reported rate, but an
    // unreported Bedrock family has no reviewed cache-write policy and must
    // be quarantined instead of receiving a manufactured 1.25x rate.
    const metaBedrock = toOutputEntry('bedrock/meta.llama3-8b-instruct-v1:0', {
      ...chat,
      litellm_provider: 'bedrock',
      input_cost_per_token: 3e-7,
      output_cost_per_token: 6e-7,
      cache_creation_input_token_cost: 3.75e-7,
    });
    expect(metaBedrock?.cache_write_per_million).toBe(0.375);

    const metaBedrockUnreported = {
      ...chat,
      litellm_provider: 'bedrock',
      input_cost_per_token: 1e-6,
      output_cost_per_token: 2e-6,
    };
    const metaModel = 'meta.llama3-70b-instruct-v1:0';
    expect(resolveCacheWritePolicy('bedrock', metaModel, metaBedrockUnreported)).toEqual({
      kind: 'unknown',
      reason: `unreviewed_cache_write_policy:bedrock:${metaModel}`,
    });
    expect(toOutputEntryResult(`bedrock/${metaModel}`, metaBedrockUnreported)).toEqual({
      kind: 'quarantine',
      provider: 'bedrock',
      model: metaModel,
      reason: `unreviewed_cache_write_policy:bedrock:${metaModel}`,
    });
    expect(toOutputEntry(`bedrock/${metaModel}`, metaBedrockUnreported)).toBeNull();
  });

  it('matches region-prefixed cross-region Bedrock profiles by family', () => {
    // Cross-region inference profiles carry region prefixes
    // (us.anthropic.claude-…, eu.openai.gpt-4o) that precede the vendor
    // segment — family matching must not be anchored to the string start.
    const anthropicProfile = toOutputEntry('bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0', {
      ...chat,
      litellm_provider: 'bedrock',
      input_cost_per_token: 3e-6,
      output_cost_per_token: 1.5e-5,
      cache_creation_input_token_cost: 3.75e-6,
    });
    expect(anthropicProfile?.cache_write_per_million).toBe(3.75);

    const openaiProfile = toOutputEntry('bedrock/us.openai.gpt-4o', {
      ...chat,
      litellm_provider: 'bedrock',
      input_cost_per_token: 2.5e-6,
      output_cost_per_token: 1e-5,
      cache_creation_input_token_cost: 3.125e-6, // must NOT be copied
    });
    expect(openaiProfile?.cache_write_per_million).toBe(0);
  });

  it('zeroes absent cache-creation rates explicitly for every non-biller provider', () => {
    // litellm_provider keys are the LITELLM_PROVIDER_MAP input names.
    const cases: Array<[string, string]> = [
      ['gemini', 'google'], ['minimax', 'minimax'], ['moonshot', 'moonshot'],
      ['deepseek', 'deepseek'], ['zai', 'zai'], ['dashscope', 'qwen'],
      ['together_ai', 'together'], ['groq', 'groq'], ['meta_llama', 'meta'],
      ['mistral', 'mistral'], ['xai', 'xai'],
    ];
    for (const [litellmProvider, ourProvider] of cases) {
      const out = toOutputEntry(`${litellmProvider}/some-model`, {
        ...chat,
        litellm_provider: litellmProvider,
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
      });
      expect(out?.cache_write_per_million, ourProvider).toBe(0);
    }
  });
  it('routes the legacy pricing command through the unified catalog refresh', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.['sync-pricing']).toMatch(/refresh-catalog/);
  });
});
