export interface CacheGuidance {
  body: string;
  fix: string;
}

export function buildCacheGuidance(provider: string, model: string, requestCount: string): CacheGuidance {
  const body = `**${model}** has a **9%** cache hit rate over the last 30 days (${requestCount} requests). `
    + 'Most providers offer prompt caching; every percentage point of hit rate matters at this volume.';

  if (provider === 'openai') {
    return {
      body,
      fix: 'Keep a stable repeated prompt prefix so automatic provider caching can reuse it. '
        + 'Keep the prefix identical across requests and confirm cache eligibility before measuring savings.',
    };
  }

  if (provider === 'anthropic') {
    return {
      body,
      fix: 'Add `cache_control: { type: "ephemeral" }` to the stable system block on Anthropic. '
        + 'Cache TTL is 5 minutes; for longer cache windows use `cache_control: { type: "ephemeral", ttl: "1h" }` when enabled.',
    };
  }

  return {
    body,
    fix: `Review ${provider} prompt-cache controls for a stable prefix and provider-specific retention before enabling cache guidance.`,
  };
}
