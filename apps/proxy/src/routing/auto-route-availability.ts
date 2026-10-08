import { MODEL_REGISTRY } from '@routeshift/shared';
import { getProvider } from '../providers/registry.js';
import { getPlatformKey } from '../providers/platform-keys.js';
import { getProviderLatencySummary } from '../billing/key-stats.js';
import { getUsableProviderKeyLabels } from '../billing/provider-key-crypto.js';
import type { AutoRouteProviderSignal } from './auto-router.js';

type BillingMode = 'subscription' | 'credits';

const PLATFORM_LABEL = 'platform';

function autoRoutableProviders(): string[] {
  return [...new Set<string>(
    MODEL_REGISTRY
      .filter((model) => model.auto_route !== false)
      .map((model) => String(model.provider)),
  )];
}

async function getEnabledTeamKeyLabels(teamId: string, providers: string[]): Promise<Map<string, string[]>> {
  const entries = await Promise.all(providers.map(async (provider) => (
    [provider, await getUsableProviderKeyLabels(teamId, provider)] as const
  )));
  return new Map(entries.filter(([, labels]) => labels.length > 0));
}

export async function getAutoRouteProviderSignals(
  teamId: string,
  billingMode: BillingMode,
): Promise<AutoRouteProviderSignal[]> {
  const providers = autoRoutableProviders();
  const teamLabels = billingMode === 'subscription'
    ? await getEnabledTeamKeyLabels(teamId, providers)
    : new Map<string, string[]>();

  return providers.map((provider) => {
    const providerImpl = getProvider(provider);
    if (!providerImpl) {
      return {
        provider,
        credential_available: false,
        unavailable_reason: 'provider_not_registered',
      };
    }

    if (billingMode === 'subscription') {
      const labels = teamLabels.get(provider);
      if (labels && labels.length > 0) {
        const latency = getProviderLatencySummary(teamId, provider, labels);
        return {
          provider,
          credential_available: true,
          latency_p95_ms: latency.p95LatencyMs,
          latency_sample_count: latency.sampleCount,
        };
      }
      return {
        provider,
        credential_available: false,
        unavailable_reason: 'missing_subscription_provider_key',
      };
    }

    // Credits mode is the only mode funded by RouteShift platform keys.
    if (getPlatformKey(provider, billingMode)) {
      const latency = getProviderLatencySummary(teamId, provider, [PLATFORM_LABEL]);
      return {
        provider,
        credential_available: true,
        latency_p95_ms: latency.p95LatencyMs,
        latency_sample_count: latency.sampleCount,
      };
    }

    return {
      provider,
      credential_available: false,
      unavailable_reason: 'missing_platform_provider_key_for_credits_billing',
    };
  });
}
