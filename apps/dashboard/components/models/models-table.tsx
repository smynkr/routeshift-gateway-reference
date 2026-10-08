'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { CatalogModel } from '@routeshift/shared';
import { ArrowRight, Brain, ChevronDown, DollarSign, Layers, Maximize } from 'lucide-react';
import { providerBorderedBadgeClass } from '@/lib/providers';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type SortKey = 'default' | 'cheapest_output' | 'cheapest_input';

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'default', label: 'Default order' },
  { value: 'cheapest_output', label: 'Cheapest output' },
  { value: 'cheapest_input', label: 'Cheapest input' },
];
const USD_PER_MILLION = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const TOKEN_COUNT = new Intl.NumberFormat('en-US');

function stableModelOrder(a: CatalogModel, b: CatalogModel): number {
  return a.owned_by.localeCompare(b.owned_by) || a.id.localeCompare(b.id);
}

function compareModels(a: CatalogModel, b: CatalogModel, sort: SortKey): number {
  let order = 0;
  if (sort === 'cheapest_output') {
    const aEmbedding = a.architecture?.modality === 'text->embedding';
    const bEmbedding = b.architecture?.modality === 'text->embedding';
    if (aEmbedding !== bEmbedding) return aEmbedding ? 1 : -1;
    order = Number(a.pricing.completion) - Number(b.pricing.completion);
  } else if (sort === 'cheapest_input') {
    order = Number(a.pricing.prompt) - Number(b.pricing.prompt);
  }
  return order || stableModelOrder(a, b);
}

function pricePerMillion(perToken: string): string {
  return USD_PER_MILLION.format(Number(perToken) * 1_000_000);
}

export function ModelsTable({ models }: { models: readonly CatalogModel[] }) {
  const [sort, setSort] = useState<SortKey>('default');
  const grouped = sort === 'default';

  const flatSorted = useMemo(() => {
    if (grouped) return [];
    return models.slice().sort((a, b) => compareModels(a, b, sort));
  }, [grouped, models, sort]);

  const byProvider = useMemo(() => {
    const groupedModels = new Map<string, CatalogModel[]>();
    for (const model of models) {
      const providerModels = groupedModels.get(model.owned_by) ?? [];
      providerModels.push(model);
      groupedModels.set(model.owned_by, providerModels);
    }
    for (const providerModels of groupedModels.values()) {
      providerModels.sort(stableModelOrder);
    }
    return groupedModels;
  }, [models]);

  const providers = useMemo(
    () => Array.from(byProvider.keys()).sort((a, b) => a.localeCompare(b)),
    [byProvider],
  );

  if (models.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground" role="status">
        No public models are available. Refresh the catalog before creating a routing rule.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <div className="relative shrink-0">
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            aria-label="Sort models"
            className="appearance-none rounded-lg border border-border bg-card py-2 pl-3 pr-8 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        </div>
      </div>

      {grouped ? (
        <div className="space-y-6">
          {providers.map((provider) => {
            const providerModels = byProvider.get(provider)!;
            return (
              <section
                key={provider}
                aria-labelledby={`provider-${provider}`}
                className="overflow-hidden rounded-xl border border-border bg-card"
              >
                <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-5 py-3">
                  <h3
                    id={`provider-${provider}`}
                    className={`rounded-md border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider ${providerBorderedBadgeClass(provider)}`}
                  >
                    {provider}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {providerModels.length} model{providerModels.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ModelTableInner models={providerModels} showProviderColumn={false} />
              </section>
            );
          })}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <ModelTableInner models={flatSorted} showProviderColumn />
        </div>
      )}
    </div>
  );
}

function ModelTableInner({
  models,
  showProviderColumn,
}: {
  models: readonly CatalogModel[];
  showProviderColumn: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className="px-5">
            <span className="flex items-center gap-1">
              <Brain className="h-3 w-3" aria-hidden="true" /> Model
            </span>
          </TableHead>
          {showProviderColumn && <TableHead scope="col" className="px-5">Provider</TableHead>}
          <TableHead scope="col" className="px-5">
            <span className="flex items-center gap-1">
              <Layers className="h-3 w-3" aria-hidden="true" /> Primary API ID
            </span>
          </TableHead>
          <TableHead scope="col" className="px-5">
            <span className="flex items-center gap-1">
              <Maximize className="h-3 w-3" aria-hidden="true" /> Context
            </span>
          </TableHead>
          <TableHead scope="col" className="px-5 text-right">
            <span className="flex items-center justify-end gap-1">
              <DollarSign className="h-3 w-3" aria-hidden="true" /> Input / 1M
            </span>
          </TableHead>
          <TableHead scope="col" className="px-5 text-right">Output / 1M</TableHead>
          <TableHead scope="col">Routing</TableHead>
          <TableHead scope="col" className="text-right"><span className="sr-only">Actions</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((model) => {
          const routing = model.catalog?.routing ?? 'explicit_only';
          const embeddingOnly = model.architecture?.output_modalities.includes('embedding') ?? false;
          const apiModelId = model.endpoints[0]?.api_model_id ?? model.id;
          return (
            <TableRow
              key={`${model.owned_by}:${model.id}`}
              data-model-id={model.id}
              data-input-price={model.pricing.prompt}
              data-output-price={model.pricing.completion}
              data-routing={routing}
            >
              <TableCell className="px-5 font-medium text-foreground">{model.id}</TableCell>
              {showProviderColumn && (
                <TableCell className="px-5">
                  <span className={`rounded-md border px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${providerBorderedBadgeClass(model.owned_by)}`}>
                    {model.owned_by}
                  </span>
                </TableCell>
              )}
              <TableCell className="px-5 font-mono text-xs text-muted-foreground">{apiModelId}</TableCell>
              <TableCell className="px-5 text-xs text-muted-foreground">{TOKEN_COUNT.format(model.context_length)}</TableCell>
              <TableCell className="px-5 text-right text-xs tabular-nums text-muted-foreground">{pricePerMillion(model.pricing.prompt)}</TableCell>
              <TableCell className="px-5 text-right text-xs tabular-nums text-muted-foreground">
                {embeddingOnly ? 'Not applicable' : pricePerMillion(model.pricing.completion)}
              </TableCell>
              <TableCell className="text-xs">
                <span className={routing === 'explicit_only' ? 'text-muted-foreground' : 'text-emerald-300'}>
                  {routing === 'explicit_only' ? 'Explicit only' : 'Auto or explicit'}
                </span>
              </TableCell>
              <TableCell className="text-right">
                {embeddingOnly ? (
                  <span className="text-xs text-muted-foreground">Catalog only</span>
                ) : (
                  <Link
                    href={`/routing/new?provider=${encodeURIComponent(model.owned_by)}&model=${encodeURIComponent(model.id)}`}
                    title={routing === 'explicit_only' ? 'Use this model explicitly in a routing rule' : 'Use this model in a routing rule'}
                    aria-label={routing === 'explicit_only'
                      ? `Use ${model.id} explicitly in a routing rule`
                      : `Use ${model.id} in a routing rule`}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-emerald-500/30 hover:bg-emerald-500/[0.06] hover:text-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    {routing === 'explicit_only' ? 'Use explicitly' : 'Use'}
                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
