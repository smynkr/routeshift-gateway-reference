import { buildModelsList } from '@routeshift/shared';
import { providerDisplayName } from '@/lib/providers';
import { LiveCatalogBadge } from '@/components/marketing/live-catalog-badge';

const PROVIDER_NAMES = Array.from(
  new Set(
    buildModelsList(null).data.flatMap((model) => model.endpoints.map((endpoint) => endpoint.provider)),
  ),
).map((provider) => providerDisplayName(provider));

export function ProviderCompatibility() {
  return (
    <section aria-labelledby="provider-compatibility-heading" className="border-b border-white/[0.04] bg-white/[0.01]">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        <div className="flex flex-col gap-7 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-emerald-400">Current catalog</p>
            <h2 id="provider-compatibility-heading" className="mt-2 text-lg font-semibold text-white">
              Provider compatibility you can inspect
            </h2>
            <LiveCatalogBadge label="Compatibility from the shipped catalog" />
          </div>
          <ul className="flex flex-wrap gap-x-6 gap-y-3 sm:max-w-2xl sm:justify-end" aria-label="Public catalog providers">
            {PROVIDER_NAMES.map((provider) => (
              <li key={provider} className="text-sm font-medium tracking-wide text-zinc-300">
                {provider}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
