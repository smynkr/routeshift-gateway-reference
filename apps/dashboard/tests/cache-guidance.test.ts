import { describe, expect, it } from 'vitest';
import { requireCurrentModel } from '@/lib/current-models';
import { buildCacheGuidance } from '@/lib/cache-guidance';

describe('provider-specific cache guidance', () => {
  it('uses automatic provider caching guidance for OpenAI without unsupported fields', () => {
    const guidance = buildCacheGuidance('openai', 'gpt-7.1', '1,200');

    expect(guidance.body).toContain('gpt-7.1');
    expect(guidance.fix).toContain('stable repeated prompt prefix');
    expect(guidance.fix).toContain('automatic provider caching');
    expect(guidance.fix).not.toContain('prompt_cache_key');
    expect(guidance.fix).not.toContain('cache_control');
    expect(guidance.fix).not.toContain('TTL');
  });

  it('uses cache_control and TTL guidance for Anthropic', () => {
    const guidance = buildCacheGuidance('anthropic', 'claude-7-sonnet', '1,200');

    expect(guidance.body).toContain('claude-7-sonnet');
    expect(guidance.fix).toContain('cache_control');
    expect(guidance.fix).toContain('TTL');
    expect(guidance.fix).not.toContain('prompt_cache_key');
  });

  it('renders guidance for the selected current coding provider', () => {
    const model = requireCurrentModel('coding');
    const guidance = buildCacheGuidance(model.provider, model.canonical_name, '1,200');

    expect(guidance.body).toContain(model.canonical_name);
    expect(guidance.fix).toContain(model.provider);
  });
});
