import { describe, it, expect } from 'vitest';
import { calculateCostMicrocents, getModelPricing, PRICING_TABLE, type ModelPricing } from '../src/cost-tables';
import { toOutputEntry } from '../scripts/sync-pricing.js';

describe('cost-tables', () => {
  it('calculates GPT-4.1 cost correctly', () => {
    const pricing = getModelPricing('openai', 'gpt-4.1');
    expect(pricing).toBeDefined();
    // Formula: tokens * price_per_million * 100 (microcents)
    // 1000 input tokens at $2.00/1M = 1000 * 2.0 * 100 = 200000 microcents
    const cost = calculateCostMicrocents(
      { input_tokens: 1000, output_tokens: 500 },
      pricing!,
    );
    expect(cost.input).toBe(200000);
    // 500 output tokens at $8.00/1M = 500 * 8.0 * 100 = 400000 microcents
    expect(cost.output).toBe(400000);
    expect(cost.total).toBe(600000);
  });

  it('calculates Haiku cost correctly', () => {
    const pricing = getModelPricing('anthropic', 'claude-haiku-4-5');
    expect(pricing).toBeDefined();
    const cost = calculateCostMicrocents(
      { input_tokens: 1000, output_tokens: 1000 },
      pricing!,
    );
    // 1000 * 1.0 * 100 = 100000
    expect(cost.input).toBe(100000);
    // 1000 * 5.0 * 100 = 500000
    expect(cost.output).toBe(500000);
    expect(cost.total).toBe(600000);
  });

  it('returns null for unknown model', () => {
    const pricing = getModelPricing('openai', 'nonexistent-model');
    expect(pricing).toBeNull();
  });

  it('returns null for unknown provider', () => {
    const pricing = getModelPricing('nonexistent-provider', 'gpt-4.1');
    expect(pricing).toBeNull();
  });

  it('returns all zeros for zero input/output tokens', () => {
    const pricing = getModelPricing('openai', 'gpt-4.1');
    expect(pricing).toBeDefined();
    const cost = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0 },
      pricing!,
    );
    expect(cost.input).toBe(0);
    expect(cost.output).toBe(0);
    expect(cost.total).toBe(0);
  });

  it('does not overflow with very large token counts', () => {
    const pricing = getModelPricing('anthropic', 'claude-opus-4-6');
    expect(pricing).toBeDefined();
    // 1 billion tokens -- large but within JS safe integer range
    // 1_000_000_000 * 25.0 * 100 = 2_500_000_000_000 (well within Number.MAX_SAFE_INTEGER)
    const cost = calculateCostMicrocents(
      { input_tokens: 1_000_000_000, output_tokens: 1_000_000_000 },
      pricing!,
    );
    expect(cost.input).toBe(1_000_000_000 * 5.0 * 100);
    expect(cost.output).toBe(1_000_000_000 * 25.0 * 100);
    expect(cost.total).toBe(cost.input + cost.output);
    expect(Number.isSafeInteger(cost.total)).toBe(true);
  });

  it('charges zero for cache writes on providers with no separate cache-write price (regression: 1.25x fallback overcharge)', () => {
    // MiniMax/Moonshot/DeepSeek/z.ai/Qwen/xAI bill cache hit/miss with no
    // cache-write charge; their rows set cache_write_per_million: 0 so the
    // Anthropic-style 1.25x-input fallback must NOT fire.
    const noWriteChargeModels = [
      ['minimax', 'MiniMax-M2'],
      ['moonshot', 'kimi-k2.6'],
      ['moonshot', 'kimi-k2.7-code'],
      ['deepseek', 'deepseek-v3.2'],
      ['zai', 'glm-5'],
      ['qwen', 'Qwen3-Coder-480B-A35B-Instruct'],
      ['xai', 'grok-4.1-fast'],
    ] as const;
    for (const [provider, model] of noWriteChargeModels) {
      const pricing = getModelPricing(provider, model);
      expect(pricing, `${provider}/${model}`).not.toBeNull();
      expect(pricing!.cache_write_per_million, `${provider}/${model}`).toBe(0);
      const cost = calculateCostMicrocents(
        { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
        pricing!,
      );
      expect(cost.cache_write, `${provider}/${model}`).toBe(0);
    }
  });
  it('charges GPT-5.6 cache writes at 1.25x the input rate', () => {
    const pricing = toOutputEntry('openai/gpt-5.6-sol', {
      mode: 'chat',
      litellm_provider: 'openai',
      input_cost_per_token: 5e-6,
      output_cost_per_token: 30e-6,
      cache_creation_input_token_cost: 6.25e-6,
    });
    expect(pricing).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      input_per_million: 5.0,
      cache_write_per_million: 6.25,
    });
    const cost = calculateCostMicrocents(
      { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
      pricing!,
    );
    expect(cost.input).toBe(Math.round(1_000_000 * pricing!.input_per_million * 100));
    expect(cost.cache_write).toBe(Math.round(1_000_000 * pricing!.input_per_million * 1.25 * 100));
    expect(cost.total).toBe(cost.input + cost.cache_write);
  });
  it('pins current official GPT-5.6 and promoted frontier prices (provider pages verified 2026-08-26)', () => {
    const expected = [
      ['openai', 'gpt-5.6', { input_per_million: 4, output_per_million: 20, cache_read_per_million: 0.4, cache_write_per_million: 5 }],
      ['openai', 'gpt-5.6-sol', { input_per_million: 4, output_per_million: 20, cache_read_per_million: 0.4, cache_write_per_million: 5 }],
      ['openai', 'gpt-5.6-terra', { input_per_million: 2, output_per_million: 12, cache_read_per_million: 0.2, cache_write_per_million: 2.5 }],
      ['openai', 'gpt-5.6-luna', { input_per_million: 0.2, output_per_million: 1.2, cache_read_per_million: 0.02, cache_write_per_million: 0.25 }],
      ['google', 'gemini-3.7-flash', { input_per_million: 0.75, output_per_million: 3.75, cache_read_per_million: 0.075 }],
      ['moonshot', 'kimi-k3', { input_per_million: 3, output_per_million: 15, cache_read_per_million: 0.3, cache_write_per_million: 0 }],
      ['qwen', 'qwen3.8-max', { input_per_million: 2, output_per_million: 6, cache_read_per_million: 0.2, cache_write_per_million: 2.5 }],
    ] as const;

    for (const [provider, model, pricing] of expected) {
      expect(getModelPricing(provider, model), `${provider}/${model}`).toMatchObject(pricing);
    }
  });

  it('prices Cloudflare GLM-5.3 and preserves live NeuralWatt GLM-5.2 legacy pricing', () => {
    expect(getModelPricing('cloudflare-workers-ai', '@cf/zai-org/glm-5.3-flash')).toMatchObject({
      input_per_million: 0.15,
      output_per_million: 0.5,
      cache_read_per_million: 0.03,
      cache_write_per_million: 0,
    });
    expect(getModelPricing('neuralwatt', 'glm-5.2')).toMatchObject({
      input_per_million: 1.45,
      output_per_million: 4.5,
      cache_read_per_million: 0.145,
      cache_write_per_million: 0,
    });
  });

  it('applies GPT-5.6 long-context prices only above 272K prompt tokens', () => {
    const pricing = getModelPricing('openai', 'gpt-5.6-sol');
    expect(pricing).toMatchObject({
      input_per_million_above_272k: 8,
      output_per_million_above_272k: 30,
      cache_read_per_million_above_272k: 0.8,
      cache_write_per_million_above_272k: 10,
    });

    const atThreshold = calculateCostMicrocents(
      { input_tokens: 272_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 },
      pricing!,
    );
    expect(atThreshold.input).toBe(Math.round(272_000 * 4 * 100));
    expect(atThreshold.output).toBe(Math.round(1_000_000 * 20 * 100));

    const aboveThreshold = calculateCostMicrocents(
      { input_tokens: 272_001, output_tokens: 1_000_000, cache_read_tokens: 100, cache_write_tokens: 100 },
      pricing!,
    );
    expect(aboveThreshold.input).toBe(Math.round(272_001 * 8 * 100));
    expect(aboveThreshold.cache_read).toBe(Math.round(100 * 0.8 * 100));
    expect(aboveThreshold.cache_write).toBe(Math.round(100 * 10 * 100));
    expect(aboveThreshold.output).toBe(Math.round(1_000_000 * 30 * 100));
  });


  it('keeps pre-GPT-5.6 Bedrock OpenAI cache writes at zero', () => {
    const pricing = toOutputEntry('bedrock/openai.gpt-5.4', {
      mode: 'chat',
      litellm_provider: 'bedrock',
      input_cost_per_token: 2.5e-6,
      output_cost_per_token: 15e-6,
      cache_creation_input_token_cost: 3.125e-6,
    });
    expect(pricing).toMatchObject({
      provider: 'bedrock',
      model: 'openai.gpt-5.4',
      cache_write_per_million: 0,
    });
    const cost = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
      pricing!,
    );
    expect(cost.cache_write).toBe(0);
    expect(cost.total).toBe(0);
  });

  it('still applies the 1.25x cache-write fallback for Anthropic (which does bill writes)', () => {
    const pricing = getModelPricing('anthropic', 'claude-opus-4-6');
    expect(pricing!.cache_write_per_million).toBe(6.25);
    const cost = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
      pricing!,
    );
    // 1.25 * input(5.0) * 1e6 tokens * 100 microcents = 625_000_000
    expect(cost.cache_write).toBe(Math.round(1_000_000 * 5.0 * 1.25 * 100));
  });

  it('RSH-81: 1h TTL cache writes use 2.0x multiplier instead of 1.25x', () => {
    const pricing = getModelPricing('anthropic', 'claude-opus-4-6');
    expect(pricing!.cache_write_per_million).toBe(6.25);
    const cost = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000, cache_write_ttl: '1h' },
      pricing!,
    );
    // 2.0 * input(5.0) * 1e6 tokens * 100 microcents = 1_000_000_000
    expect(cost.cache_write).toBe(Math.round(1_000_000 * 5.0 * 2.0 * 100));
  });

  it('RSH-81: 5m TTL cache writes still use 1.25x multiplier', () => {
    const pricing = getModelPricing('anthropic', 'claude-opus-4-6');
    const cost = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000, cache_write_ttl: '5m' },
      pricing!,
    );
    expect(cost.cache_write).toBe(Math.round(1_000_000 * 5.0 * 1.25 * 100));
  });

  it('RSH-81: absent TTL defaults to 1.25x (backward compatibility)', () => {
    const pricing = getModelPricing('anthropic', 'claude-opus-4-6');
    const cost = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000 },
      pricing!,
    );
    expect(cost.cache_write).toBe(Math.round(1_000_000 * 5.0 * 1.25 * 100));
  });

  it('RSH-81: explicit cache_write_per_million:0 overrides TTL multiplier', () => {
    // Providers like DeepSeek that set cache_write_per_million: 0 should
    // never be charged for cache writes regardless of TTL.
    const pricing = getModelPricing('deepseek', 'deepseek-v3.2');
    expect(pricing!.cache_write_per_million).toBe(0);
    const cost = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000, cache_write_ttl: '1h' },
      pricing!,
    );
    expect(cost.cache_write).toBe(0);
  });

  it('1h TTL scales an EXPLICIT (nonzero) cache-write rate too, not just the multiplier path', () => {
    // Generated Anthropic rows carry an explicit cache_write_per_million baked
    // at the 1.25x-input (5-minute) rate. A 1h request must still bill at 2.0x
    // input, i.e. the explicit rate scaled by 2.0/1.25 = 1.6 — not the raw
    // explicit rate (which was the underbilling bug).
    const explicitPricing = {
      provider: 'anthropic',
      model: 'test-explicit-write',
      input_per_million: 4.0,
      output_per_million: 20.0,
      cache_write_per_million: 5.0, // == input * 1.25 (the 5-minute rate)
    };
    const fiveMin = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000, cache_write_ttl: '5m' },
      explicitPricing,
    );
    const oneHour = calculateCostMicrocents(
      { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 1_000_000, cache_write_ttl: '1h' },
      explicitPricing,
    );
    // 5m: explicit 5.0/M → 500_000_000 microcents. 1h: 5.0 * 1.6 = 8.0/M → 800_000_000.
    expect(fiveMin.cache_write).toBe(Math.round(1_000_000 * 5.0 * 100));
    expect(oneHour.cache_write).toBe(Math.round(1_000_000 * 8.0 * 100));
    expect(oneHour.cache_write).toBeGreaterThan(fiveMin.cache_write);
  });

  it('returns null for unknown provider with known model', () => {
    // The example used to be ('azure', 'gpt-4.1') back when our pricing
    // table only knew about hand-curated entries. LiteLLM now imports
    // Azure pricing too (LAY-313), so the example needs to be a provider
    // neither table tracks.
    const pricing = getModelPricing('does-not-exist-provider', 'gpt-4.1');
    expect(pricing).toBeNull();
  });

  describe('all known pricing entries are accessible via getModelPricing', () => {
    const knownEntries: Array<{ provider: string; model: string }> = [
      { provider: 'openai', model: 'gpt-5' },
      { provider: 'azure', model: 'gpt-5.4' },
      { provider: 'azure', model: 'gpt-5.5' },
      { provider: 'openai', model: 'gpt-4.1' },
      { provider: 'openai', model: 'gpt-4.1-mini' },
      { provider: 'openai', model: 'gpt-4.1-nano' },
      { provider: 'openai', model: 'o3' },
      { provider: 'openai', model: 'o4-mini' },
      { provider: 'anthropic', model: 'claude-opus-4-6' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'anthropic', model: 'claude-opus-4-5' },
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'anthropic', model: 'claude-fable-5' },
      { provider: 'anthropic', model: 'claude-sonnet-5' },
      { provider: 'google', model: 'gemini-2.5-pro' },
      { provider: 'google', model: 'gemini-2.5-flash' },
    ];

    for (const { provider, model } of knownEntries) {
      it(`returns pricing for ${provider}/${model}`, () => {
        const pricing = getModelPricing(provider, model);
        expect(pricing).not.toBeNull();
        expect(pricing!.provider).toBe(provider);
        expect(pricing!.model).toBe(model);
        expect(pricing!.input_per_million).toBeGreaterThan(0);
        expect(pricing!.output_per_million).toBeGreaterThan(0);
      });
    }
  });

  it('prices GA Opus 4.7 but still suppresses the never-shipped Sonnet 4.7', () => {
    // Opus 4.7 is now GA and hand-priced ($5/$25); only Sonnet 4.7 stays removed.
    expect(getModelPricing('anthropic', 'claude-opus-4-7')).toMatchObject({
      input_per_million: 5,
      output_per_million: 25,
    });
    expect(getModelPricing('anthropic', 'claude-sonnet-4-7')).toBeNull();
    expect(getModelPricing('bedrock', 'us.anthropic.claude-sonnet-4-7')).toBeNull();
  });

  it('uses explicit generated-snapshot pricing for Azure GPT 5.4/5.5', () => {
    expect(getModelPricing('azure', 'gpt-5.4')).toMatchObject({
      input_per_million: 2.5,
      output_per_million: 15,
    });
    expect(getModelPricing('azure', 'gpt-5.5')).toMatchObject({
      input_per_million: 5,
      output_per_million: 30,
    });
  });

  it('prices native-provider frontier models without placeholder zeros', () => {
    expect(getModelPricing('minimax', 'MiniMax-M2')).toMatchObject({
      input_per_million: 0.3,
      output_per_million: 1.2,
      cache_read_per_million: 0.03,
    });
    expect(getModelPricing('moonshot', 'kimi-k2.6')).toMatchObject({
      input_per_million: 0.95,
      output_per_million: 4.0,
      cache_read_per_million: 0.16,
    });
    expect(getModelPricing('zai', 'glm-5')).toMatchObject({
      input_per_million: 1,
      output_per_million: 3.2,
      cache_read_per_million: 0.1,
    });
    expect(getModelPricing('xiaomi', 'mimo-v2.5-pro')).toMatchObject({
      input_per_million: 0,
      output_per_million: 0,
    });
    expect(getModelPricing('xiaomi', 'mimo-v2-flash')).toMatchObject({
      input_per_million: 0,
      output_per_million: 0,
    });
  });

  it('prices additional tracked-provider Qwen and OpenAI OSS models', () => {
    expect(getModelPricing('qwen', 'qwen3.7-max')).toMatchObject({ input_per_million: 1.6, output_per_million: 6.4 });
    expect(getModelPricing('qwen', 'qwen3.7-plus')).toMatchObject({ input_per_million: 0.8, output_per_million: 2.0 });
    expect(getModelPricing('qwen', 'qwen3.6-flash')).toMatchObject({ input_per_million: 0.2, output_per_million: 0.6 });
    expect(getModelPricing('qwen', 'Qwen3-Next-80B-Thinking')).toMatchObject({ input_per_million: 0.15, output_per_million: 1.2 });
    expect(getModelPricing('qwen', 'Qwen3-Next-80B-Instruct')).toMatchObject({ input_per_million: 0.15, output_per_million: 1.2 });
    expect(getModelPricing('openai', 'gpt-oss-120b')).toMatchObject({ input_per_million: 0.09, output_per_million: 0.36 });
    expect(getModelPricing('openai', 'gpt-oss-20b')).toMatchObject({
      input_per_million: 0.07,
      output_per_million: 0.25,
      cache_read_per_million: 0.007,
    });
  });

  it('prices newly tracked native providers and Azure deployment variants', () => {
    expect(getModelPricing('xai', 'grok-4.20-reasoning')).toMatchObject({ input_per_million: 1.25, output_per_million: 2.5, cache_read_per_million: 0.2 });
    expect(getModelPricing('xai', 'grok-4.5')).toMatchObject({
      input_per_million: 2,
      output_per_million: 6,
      cache_read_per_million: 0.3,
      cache_write_per_million: 0,
    });
    expect(getModelPricing('deepseek', 'deepseek-v3.2')).toMatchObject({ input_per_million: 0.56, output_per_million: 1.68, cache_read_per_million: 0.056 });
    expect(getModelPricing('mistral', 'codestral-2')).toMatchObject({ input_per_million: 0.3, output_per_million: 0.9 });
    expect(getModelPricing('meta', 'llama-4-maverick')).toMatchObject({ input_per_million: 0.35, output_per_million: 1.15 });
    expect(getModelPricing('azure', 'gpt-5.5-pro')).toMatchObject({ input_per_million: 10, output_per_million: 45, cache_read_per_million: 1 });
    expect(getModelPricing('azure', 'gpt-oss-120b')).toMatchObject({ input_per_million: 0.15, output_per_million: 0.6 });
  });

  it('holds registry-wide uniqueness on canonical_name and api_model_id (RSH-167 audit)', async () => {
    // The 49 covered-id onboarding made collisions a live hazard: a duplicate
    // public row would appear twice in the unauthenticated catalog and make
    // resolveProvider order-dependent. Locked here for the whole registry.
    const { MODEL_REGISTRY } = await import('../src/models');
    const canon = new Map<string, string>();
    const api = new Map<string, string>();
    for (const m of MODEL_REGISTRY) {
      // resolveProvider takes a BARE id and scans the whole registry, so the
      // id namespace is global: ANY repeat — including an exact same-provider
      // duplicate row (the paste-twice mistake) — is a collision.
      const priorCanon = canon.get(m.canonical_name);
      const priorApi = api.get(m.api_model_id);
      if (priorCanon !== undefined) {
        throw new Error(`duplicate canonical_name '${m.canonical_name}' (${priorCanon} vs ${m.provider})`);
      }
      if (priorApi !== undefined) {
        throw new Error(`duplicate api_model_id '${m.api_model_id}' (${priorApi} vs ${m.provider})`);
      }
      canon.set(m.canonical_name, m.provider);
      api.set(m.api_model_id, m.provider);
    }
  });

  it('RSH-168 curated overrides win over the generated anomalies', () => {
    // (a) Bedrock bare kimi-k2.5: upstream 3.03 matches no AWS region ->
    //     AWS US list rate 3.00 (APAC premium rows stay at 3.60).
    expect(getModelPricing('bedrock', 'moonshotai.kimi-k2.5')).toMatchObject({
      input_per_million: 0.6,
      output_per_million: 3,
    });
    // (b) us-gov llama3-8b: upstream misfiled 70B input rate -> AWS list
    //     rate 0.30/0.60.
    expect(getModelPricing('bedrock', 'us-gov-east-1/meta.llama3-8b-instruct-v1:0')).toMatchObject({
      input_per_million: 0.3,
      output_per_million: 0.6,
    });
    expect(getModelPricing('bedrock', 'us-gov-west-1/meta.llama3-8b-instruct-v1:0')).toMatchObject({
      input_per_million: 0.3,
      output_per_million: 0.6,
    });
    // Region-premium kimi rows keep the AWS APAC list rate (1.2x).
    expect(getModelPricing('bedrock', 'ap-northeast-1/moonshotai.kimi-k2.5')?.output_per_million).toBe(3.6);
  });

  it('RSH-168 anomaly-class invariants hold across the effective table', async () => {
    const { LITELLM_GENERATED_PRICING } = await import('../src/litellm-pricing.generated');
    const all = [...PRICING_TABLE, ...LITELLM_GENERATED_PRICING];
    // Curated overrides shadow generated rows at lookup (Map last-write-wins);
    // the invariant applies to the EFFECTIVE table, so skip shadowed rows.
    const curatedKeys = new Set(PRICING_TABLE.map((r) => `${r.provider}:${r.model}`));
    for (const row of all) {
      if (curatedKeys.has(`${row.provider}:${row.model}`)) continue;
      // No kimi-k2.5 row may carry the 3.03 anomaly (allowed: 3.0 or 3.6).
      if (row.model.includes('kimi-k2.5')) {
        expect([3, 3.6], `${row.provider}:${row.model} output ${row.output_per_million}`).toContain(row.output_per_million);
      }
      // No 8B-class llama row may carry the 70B input rate in output.
      if (row.model.includes('llama3-8b') || row.model.includes('llama3-8B')) {
        expect(row.output_per_million, `${row.provider}:${row.model}`).not.toBe(2.65);
      }
    }
    // Corroboration: the us-gov 70B rows the 8B misfile narrative rests on.
    expect(getModelPricing('bedrock', 'us-gov-east-1/meta.llama3-70b-instruct-v1:0')).toMatchObject({
      input_per_million: 2.65,
      output_per_million: 3.5,
    });
    expect(getModelPricing('bedrock', 'us-gov-west-1/meta.llama3-70b-instruct-v1:0')).toMatchObject({
      input_per_million: 2.65,
      output_per_million: 3.5,
    });
    // The curated overrides shadow the generated anomalies (effective table).
    expect(getModelPricing('bedrock', 'moonshotai.kimi-k2.5')?.output_per_million).toBe(3);
    expect(getModelPricing('bedrock', 'us-gov-east-1/meta.llama3-8b-instruct-v1:0')?.output_per_million).toBe(0.6);
  });

  it('resolves every registered model to explicit or generated pricing', async () => {
    const { MODEL_REGISTRY } = await import('../src/models');

    for (const model of MODEL_REGISTRY) {
      expect(getModelPricing(model.provider, model.canonical_name), `${model.provider}:${model.canonical_name}`).not.toBeNull();
    }
  });

  it('an explicit cache_write_per_million: 0 bills zero under BOTH TTL tiers (sync curation)', () => {
    // The sync's NO_WRITE-BILLER curation writes explicit 0 for openai etc.
    // cost-tables must resolve that 0 with nullish semantics — `||` would
    // resurrect the 1.25x fallback and silently re-overcharge.
    const zeroWrite: ModelPricing = { input_per_million: 2, output_per_million: 12, cache_write_per_million: 0 };
    const base = calculateCostMicrocents(
      { input_tokens: 100, output_tokens: 100, cache_write_tokens: 100_000, cache_write_ttl: undefined },
      zeroWrite,
    );
    expect(base.cache_write).toBe(0);
    const oneHour = calculateCostMicrocents(
      { input_tokens: 100, output_tokens: 100, cache_write_tokens: 100_000, cache_write_ttl: '1h' },
      zeroWrite,
    );
    expect(oneHour.cache_write).toBe(0);
    // Control: an Anthropic-style explicit rate still scales for the 1h tier.
    const realWrite: ModelPricing = { input_per_million: 5, output_per_million: 25, cache_write_per_million: 6.25 };
    const scaled = calculateCostMicrocents(
      { input_tokens: 100, output_tokens: 100, cache_write_tokens: 100_000, cache_write_ttl: '1h' },
      realWrite,
    );
    // tokens * rate_per_million * 100 = microcents: 100000 * 10.0 * 100.
    expect(scaled.cache_write).toBe(100_000 * 10.0 * 100);
  });

  it('keeps auto-routable model pricing non-zero', async () => {
    const { MODEL_REGISTRY } = await import('../src/models');

    for (const model of MODEL_REGISTRY) {
      if (model.auto_route === false) continue;
      const pricing = getModelPricing(model.provider, model.canonical_name);
      expect(pricing, `${model.provider}:${model.canonical_name}`).not.toBeNull();
      expect(pricing!.input_per_million, `${model.provider}:${model.canonical_name}`).toBeGreaterThan(0);
      expect(pricing!.output_per_million, `${model.provider}:${model.canonical_name}`).toBeGreaterThan(0);
    }
  });

  it('keeps subscription-priced Xiaomi models explicit-only so zero pricing cannot win cheapest auto-route', async () => {
    const { MODEL_REGISTRY } = await import('../src/models');

    for (const modelName of ['mimo-v2.5-pro', 'mimo-v2-flash']) {
      const model = MODEL_REGISTRY.find((entry) => entry.provider === 'xiaomi' && entry.canonical_name === modelName);
      expect(model, modelName).toMatchObject({ auto_route: false });
      expect(getModelPricing('xiaomi', modelName)).toMatchObject({
        input_per_million: 0,
        output_per_million: 0,
      });
    }
  });


  it('ModelPricing interface supports cache_read and cache_write fields', () => {
    // Verify the type allows cache pricing fields by constructing a valid object
    const pricingWithCache: ModelPricing = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      input_per_million: 3.0,
      output_per_million: 15.0,
      cache_read_per_million: 0.3,
      cache_write_per_million: 3.75,
    };
    expect(pricingWithCache.cache_read_per_million).toBe(0.3);
    expect(pricingWithCache.cache_write_per_million).toBe(3.75);
  });

  it('keeps cache pricing fields optional on a manually defined model without caching', () => {
    const pricing: ModelPricing = {
      provider: 'openai',
      model: 'model-without-cache',
      input_per_million: 1,
      output_per_million: 2,
    };
    expect(pricing.cache_read_per_million).toBeUndefined();
    expect(pricing.cache_write_per_million).toBeUndefined();
  });
  it('merges generated optional cache and long-context rates under curated base prices', () => {
    const pricing = getModelPricing('openai', 'gpt-5.4');

    expect(pricing).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4',
      input_per_million: 2.5,
      output_per_million: 15,
      cache_read_per_million: 0.25,
      cache_write_per_million: 0,
      input_per_million_above_272k: 5,
      output_per_million_above_272k: 22.5,
      cache_read_per_million_above_272k: 0.5,
    });
  });
});
