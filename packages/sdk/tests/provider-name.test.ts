import { describe, it, expect } from 'vitest';
import { PROVIDERS } from '@routeshift/shared';
import { SDK_PROVIDER_NAMES, type ProviderName } from '../src/types';

// The SDK's ProviderName union is a deliberate standalone mirror of shared's
// PROVIDERS list (the SDK ships dependency-free). This guard makes drift a
// hard failure on BOTH axes:
//
//   * Compile-time: `Record<ProviderName, true>` must have exactly one key per
//     ProviderName member — a missing key (new union member, no entry here) is
//     a TS error, and an extra key (entry here, not in the union) is too.
//   * Runtime: the key set must equal shared's PROVIDERS exactly, so the SDK
//     union can never silently fall behind (or ahead of) the gateway's
//     supported providers.
const ALL_PROVIDER_NAMES: Record<ProviderName, true> = {
  openai: true,
  anthropic: true,
  google: true,
  together: true,
  groq: true,
  zai: true,
  'cloudflare-workers-ai': true,
  neuralwatt: true,
  xiaomi: true,
  minimax: true,
  moonshot: true,
  qwen: true,
  azure: true,
  bedrock: true,
  xai: true,
  deepseek: true,
  mistral: true,
  meta: true,
};

describe('SDK ProviderName ↔ shared PROVIDERS', () => {
  it('covers exactly the providers the gateway supports', () => {
    expect([...SDK_PROVIDER_NAMES].sort()).toEqual(Object.keys(ALL_PROVIDER_NAMES).sort());
    expect(Object.keys(ALL_PROVIDER_NAMES).sort()).toEqual([...PROVIDERS].sort());
  });
});
