import Link from 'next/link';
import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import { buildModelsList } from '@routeshift/shared';
import { DashboardShell } from '@/components/dashboard-shell';
import { ModelsTable } from '@/components/models/models-table';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import { requireTeamMembership, type AuthorizedTeamUser } from '@/lib/rbac';

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 4,
});

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000) return `${tokens / 1_000}K`;
  return String(tokens);
}

function formatPrice(value: string): string {
  return `${USD.format(Number(value) * 1_000_000)} / 1M`;
}

const publicModels = buildModelsList(null).data
  .slice()
  .sort((a, b) => a.owned_by.localeCompare(b.owned_by) || a.id.localeCompare(b.id));

const providerCount = new Set(publicModels.map((model) => model.owned_by)).size;

const PRICING_DISCLAIMER =
  'Pricing rows come from the RouteShift shared price table and may differ from provider invoice totals after provider discounts or account-specific terms.';

// Auth-adaptive route: /models is public in middleware, so crawlers and
// signed-out visitors get the marketing catalog, while signed-in team members
// get the in-shell catalog with benchmarks and the "Use in routing rule" flow.
export default async function ModelsPage() {
  // The membership probe must never take down the public catalog: on failure
  // fall back to the marketing variant. Next.js implements redirect()/notFound()
  // as thrown control-flow errors — rethrow those; anything else is a degraded
  // probe and is logged (console.error reaches Sentry via the console
  // integration) so the fallback never hides operational drift.
  let member: AuthorizedTeamUser | null = null;
  try {
    member = await requireTeamMembership();
  } catch (error) {
    const digest = (error as { digest?: string } | null)?.digest;
    if (digest?.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND') throw error;
    console.error('models: membership probe failed; serving public catalog', error);
    member = null;
  }

  if (member) {
    return (
      <DashboardShell>
        <div className="space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-3xl font-bold text-white">Models</h2>
              <p className="mt-1 text-neutral-400">
                The effective public catalog — pricing, context, and honest routing shortcuts.
              </p>
            </div>
            <Link
              href="/models/compare"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-4 text-sm font-medium text-neutral-200 transition-all hover:border-emerald-500/30 hover:bg-emerald-500/[0.06] hover:text-emerald-300"
            >
              <ArrowLeftRight className="h-4 w-4" />
              Compare models
            </Link>
          </div>

          <ModelsTable models={publicModels} />

          <p className="text-sm text-neutral-500">{PRICING_DISCLAIMER}</p>
        </div>
      </DashboardShell>
    );
  }

  return (
    <div className="dark min-h-screen bg-[#09090b] text-white">
      <MarketingNav />
      <main className="bg-[#050706]">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6 lg:px-8">
          <header className="flex flex-col gap-5 border-b border-white/[0.08] pb-8 md:flex-row md:items-end md:justify-between">
            <div className="max-w-2xl">
              <p className="mb-3 text-xs font-semibold uppercase text-emerald-300">
                RouteShift model catalog
              </p>
              <h1 className="text-3xl font-semibold sm:text-4xl">Supported Models</h1>
              <p className="mt-3 text-sm leading-6 text-zinc-400">
                The effective, catalog-discoverable model set for RouteShift&apos;s OpenAI-compatible APIs, including explicit-only and embedding rows. Catalog discovery marks compatibility-capable entries; it does not promise live provider availability.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div className="border-l border-white/[0.08] pl-4">
                <p className="text-2xl font-semibold">{publicModels.length}</p>
                <p className="text-zinc-400">models</p>
              </div>
              <div className="border-l border-white/[0.08] pl-4">
                <p className="text-2xl font-semibold">{providerCount}</p>
                <p className="text-zinc-400">providers</p>
              </div>
              <div className="border-l border-white/[0.08] pl-4">
                <p className="text-2xl font-semibold">{publicModels.filter((model) => model.catalog?.routing === 'auto_or_explicit').length}</p>
                <p className="text-zinc-400">auto-route</p>
              </div>
            </div>
          </header>

          <section className="overflow-hidden border border-white/[0.08]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] border-collapse text-left text-sm">
                <thead className="bg-white/[0.03] text-xs uppercase text-zinc-400">
                  <tr>
                    <th className="px-4 py-3 font-medium">Model</th>
                    <th className="px-4 py-3 font-medium">Provider</th>
                    <th className="px-4 py-3 font-medium">Context</th>
                    <th className="px-4 py-3 font-medium">Input</th>
                    <th className="px-4 py-3 font-medium">Output</th>
                    <th className="px-4 py-3 font-medium">Routing</th>
                  </tr>
                </thead>
                <tbody>
                  {publicModels.map((model) => {
                    const apiModelId = model.endpoints[0]?.api_model_id ?? model.id;
                    const routing = model.catalog?.routing ?? 'explicit_only';
                    return (
                      <tr
                        key={`${model.owned_by}:${model.id}`}
                        data-model-id={model.id}
                        data-input-price={model.pricing.prompt}
                        data-output-price={model.pricing.completion}
                        data-routing={routing}
                        className="border-t border-white/[0.06]"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-white">{model.id}</div>
                          {apiModelId !== model.id && (
                            <div className="mt-1 text-xs text-zinc-400">{apiModelId}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-300">{model.owned_by}</td>
                        <td className="px-4 py-3 text-zinc-300">{formatContext(model.context_length)}</td>
                        <td className="px-4 py-3 text-zinc-300">{formatPrice(model.pricing.prompt)}</td>
                        <td className="px-4 py-3 text-zinc-300">
                          {model.architecture?.modality === 'text->embedding'
                            ? 'Not applicable'
                            : formatPrice(model.pricing.completion)}
                        </td>
                        <td className="px-4 py-3">
                          <span className={routing === 'explicit_only' ? 'text-zinc-400' : 'text-emerald-300'}>
                            {routing === 'explicit_only' ? 'Explicit only' : 'Auto or explicit'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="flex flex-col gap-3 border-t border-white/[0.08] pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-zinc-400">{PRICING_DISCLAIMER}</p>
            <Link
              href="/register"
              className="inline-flex items-center gap-2 text-sm font-medium text-emerald-300 hover:text-emerald-200"
            >
              Start routing
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
