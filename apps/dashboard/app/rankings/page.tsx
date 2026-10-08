import Link from 'next/link';
import { ArrowRight, Database, Gauge, Trophy } from 'lucide-react';
import {
  CATALOG_FRESHNESS_MANIFEST,
  buildModelsList,
  type CapabilityAxis,
  type CatalogModel,
} from '@routeshift/shared';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  rankCapability,
  rankCheapestInput,
  rankCheapestOutput,
  rankLargestContext,
} from '@/lib/model-rankings';
import { providerBorderedBadgeClass, providerDisplayName } from '@/lib/providers';

const DISPLAY_LIMIT = 10;
const CATALOG_MODELS = buildModelsList(null).data;
const GENERATED_AT = CATALOG_FRESHNESS_MANIFEST.generated_at;
const GENERATED_LABEL = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
}).format(new Date(GENERATED_AT));
const USD_PER_MILLION = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

function formatPrice(perToken: string): string {
  return `${USD_PER_MILLION.format(Number(perToken) * 1_000_000)} / 1M`;
}

function formatContext(tokens: number): string {
  return `${new Intl.NumberFormat('en-US').format(tokens)} tokens`;
}

function RoutingBadge({ model }: { model: CatalogModel }) {
  const explicitOnly = model.catalog?.routing === 'explicit_only';
  return (
    <span className={explicitOnly ? 'text-neutral-400' : 'text-emerald-300'}>
      {explicitOnly ? 'Explicit only' : 'Auto or explicit'}
    </span>
  );
}

interface RankingSectionProps {
  id: string;
  title: string;
  description: string;
  models: readonly CatalogModel[];
  valueHeading: string;
  valueFor: (model: CatalogModel) => string;
}

function RankingSection({
  id,
  title,
  description,
  models,
  valueHeading,
  valueFor,
}: RankingSectionProps) {
  return (
    <section aria-labelledby={id} className="space-y-4">
      <div>
        <h2 id={id} className="text-xl font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableCaption className="sr-only">{title} model ranking</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-12">Rank</TableHead>
              <TableHead scope="col">Model</TableHead>
              <TableHead scope="col">Provider</TableHead>
              <TableHead scope="col">{valueHeading}</TableHead>
              <TableHead scope="col">Routing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.slice(0, DISPLAY_LIMIT).map((model, index) => (
              <TableRow key={`${model.owned_by}:${model.id}`}>
                <TableCell className="font-medium text-muted-foreground">{index + 1}</TableCell>
                <TableCell className="font-mono text-sm font-medium text-foreground">{model.id}</TableCell>
                <TableCell>
                  <span className={`rounded-md border px-2 py-0.5 text-xs font-semibold ${providerBorderedBadgeClass(model.owned_by)}`}>
                    {providerDisplayName(model.owned_by)}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-sm tabular-nums text-foreground">{valueFor(model)}</TableCell>
                <TableCell className="text-sm"><RoutingBadge model={model} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

const CAPABILITY_SECTIONS: ReadonlyArray<{
  axis: CapabilityAxis;
  title: string;
}> = [
  { axis: 'agentic', title: 'Agentic capability' },
  { axis: 'coding', title: 'Coding capability' },
  { axis: 'intelligence', title: 'Intelligence capability' },
];

function CapabilityRankingSection({
  axis,
  title,
  models,
}: {
  axis: CapabilityAxis;
  title: string;
  models: readonly CatalogModel[];
}) {
  return (
    <section aria-labelledby={`capability-${axis}`} className="space-y-4">
      <div>
        <h2 id={`capability-${axis}`} className="text-xl font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Higher is stronger. Rows appear only when the catalog carries a dated source for this axis.
        </p>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <Table>
          <TableCaption className="sr-only">{title} model ranking with source provenance</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="w-12">Rank</TableHead>
              <TableHead scope="col">Model</TableHead>
              <TableHead scope="col">Provider</TableHead>
              <TableHead scope="col">Index</TableHead>
              <TableHead scope="col">Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.slice(0, DISPLAY_LIMIT).map((model, index) => {
              const capability = model.capability_indices!;
              return (
                <TableRow key={`${model.owned_by}:${model.id}`}>
                  <TableCell className="font-medium text-muted-foreground">{index + 1}</TableCell>
                  <TableCell className="font-mono text-sm font-medium text-foreground">{model.id}</TableCell>
                  <TableCell>{providerDisplayName(model.owned_by)}</TableCell>
                  <TableCell className="font-mono tabular-nums text-foreground">{capability[axis]}</TableCell>
                  <TableCell className="max-w-sm whitespace-normal text-xs leading-5 text-muted-foreground">
                    {capability.source} · as of {capability.source_as_of}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export default function RankingsPage() {
  const capabilityRankings = CAPABILITY_SECTIONS
    .map((section) => ({ ...section, models: rankCapability(CATALOG_MODELS, section.axis) }))
    .filter((section) => section.models.length > 0);

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <MarketingNav />
      <main className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 md:py-16 lg:px-8">
        <header className="border-b border-border pb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
            <Database className="h-3.5 w-3.5" aria-hidden="true" />
            Effective public catalog
          </div>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Model rankings
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
            Deterministic views of RouteShift&apos;s effective public model catalog. These tables rank catalog facts, not adoption or traffic estimates.
          </p>
          <div className="mt-5 grid gap-3 text-sm text-muted-foreground md:grid-cols-2">
            <p className="flex items-start gap-2">
              <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />
              <span>
                <strong className="font-medium text-foreground">Method.</strong>{' '}
                Prices sort ascending; context and sourced capability indices sort descending. Ties use provider, then model ID.
              </span>
            </p>
            <p className="flex items-start gap-2">
              <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
              <span>
                <strong className="font-medium text-foreground">Source.</strong>{' '}
                RouteShift curated registry plus the generated LiteLLM supplement. Generated{' '}
                <time dateTime={GENERATED_AT}>{GENERATED_LABEL} UTC</time>.
              </span>
            </p>
          </div>
        </header>

        <div className="mt-10 space-y-12">
          <RankingSection
            id="cheapest-input"
            title="Cheapest input"
            description="Positive catalog input prices, lowest cost per million tokens first. Zero or unavailable prices are omitted."
            models={rankCheapestInput(CATALOG_MODELS)}
            valueHeading="Input price"
            valueFor={(model) => formatPrice(model.pricing.prompt)}
          />
          <RankingSection
            id="cheapest-output"
            title="Cheapest output"
            description="Positive catalog output prices, lowest cost per million tokens first. Embeddings, zero prices, and unavailable prices are omitted."
            models={rankCheapestOutput(CATALOG_MODELS)}
            valueHeading="Output price"
            valueFor={(model) => formatPrice(model.pricing.completion)}
          />
          <RankingSection
            id="largest-context"
            title="Largest context"
            description="Published catalog context windows, highest token count first."
            models={rankLargestContext(CATALOG_MODELS)}
            valueHeading="Context window"
            valueFor={(model) => formatContext(model.context_length)}
          />
          {capabilityRankings.map((section) => (
            <CapabilityRankingSection
              key={section.axis}
              axis={section.axis}
              title={section.title}
              models={section.models}
            />
          ))}
        </div>

        <div className="mt-12 border-t border-border pt-6">
          <Link
            href="/models"
            className="inline-flex items-center gap-2 text-sm font-medium text-emerald-300 transition-colors hover:text-emerald-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            Browse the complete effective catalog
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
