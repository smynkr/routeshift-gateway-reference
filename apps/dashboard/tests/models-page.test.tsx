// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildModelsList, type CatalogModel } from '@routeshift/shared';
import CompareModelsPage from '@/app/(dashboard)/models/compare/page';
import ModelsPage from '@/app/models/page';
import { ModelsTable } from '@/components/models/models-table';
import { CURRENT_MODELS } from '@/lib/current-models';

const h = vi.hoisted(() => ({
  requireTeamMembership: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: h.requireTeamMembership,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

function visit(node: ReactNode, callback: (element: ReactElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, callback);
    return;
  }
  if (!isValidElement(node)) return;
  callback(node);
  // ReactElement props are in-process JSX values; the recursive walker only reads children.
  const props = node.props as { children?: ReactNode };
  visit(props.children, callback);
}

function findElement(node: ReactNode, type: ReactElement['type']): ReactElement | undefined {
  let match: ReactElement | undefined;
  visit(node, (element) => {
    if (!match && element.type === type) match = element;
  });
  return match;
}

interface SurfaceRow {
  id: string;
  input: string;
  output: string;
  routing: string;
}

function publicRows(node: ReactNode): SurfaceRow[] {
  const rows: SurfaceRow[] = [];
  visit(node, (element) => {
    // Host-row props are authored by ModelsPage; the test records its data contract.
    const props = element.props as Record<string, unknown>;
    if (element.type !== 'tr' || typeof props['data-model-id'] !== 'string') return;
    rows.push({
      id: props['data-model-id'],
      input: String(props['data-input-price']),
      output: String(props['data-output-price']),
      routing: String(props['data-routing']),
    });
  });
  return rows;
}

function metadata(models: readonly CatalogModel[]): SurfaceRow[] {
  return models
    .map((model) => ({
      id: model.id,
      input: model.pricing.prompt,
      output: model.pricing.completion,
      routing: model.catalog?.routing ?? 'explicit_only',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function fixtureModel({
  id,
  modality,
}: {
  id: string;
  modality?: 'text->embedding';
}): CatalogModel {
  const completion = modality ? '0' : '0.000002';
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'openai',
    name: id,
    context_length: 128_000,
    pricing: { prompt: '0.000001', completion },
    ...(modality ? {
      architecture: {
        modality,
        input_modalities: ['text'],
        output_modalities: ['embedding'],
      },
    } : {}),
    catalog: { source: 'generated', routing: 'explicit_only', source_as_of: '2026-08-26' },
    endpoints: [{
      provider: 'openai',
      api_model_id: id,
      context_length: 128_000,
      pricing: { prompt: '0.000001', completion },
      data_policy: { zdr: false },
    }],
  };
}

beforeEach(() => h.requireTeamMembership.mockReset());
afterEach(() => cleanup());

describe('/models effective catalog parity', () => {
  it('feeds signed-in and public variants the same IDs, prices, and routing metadata', async () => {
    const expected = buildModelsList(null).data;

    h.requireTeamMembership.mockResolvedValueOnce(null);
    const publicTree = await ModelsPage();
    const publicMetadata = publicRows(publicTree).sort((a, b) => a.id.localeCompare(b.id));

    h.requireTeamMembership.mockResolvedValueOnce({
      teamId: 'team_1',
      userId: 'user_1',
      role: 'admin',
    });
    const signedTree = await ModelsPage();
    const table = findElement(signedTree, ModelsTable);
    // This is the in-process JSX contract between the page and ModelsTable.
    const tableProps = table?.props as { models?: readonly CatalogModel[] } | undefined;
    const signedModels = tableProps?.models;

    expect(publicMetadata).toEqual(metadata(expected));
    expect(metadata(signedModels ?? [])).toEqual(metadata(expected));
    expect(expected.some((model) => model.catalog?.source === 'generated')).toBe(true);
  });

  it('describes catalog discovery and compatibility without promising live provider availability', async () => {
    h.requireTeamMembership.mockResolvedValueOnce(null);
    render(await ModelsPage());

    expect(screen.getByText(/effective, catalog-discoverable model set/i)).toBeTruthy();
    expect(screen.getByText(/OpenAI-compatible APIs/i)).toBeTruthy();
    expect(screen.queryByText(/currently available/i)).toBeNull();
  });

  it('keeps public catalog construction server-side and the wide table responsive', () => {
    const source = readFileSync('app/models/page.tsx', 'utf8');
    expect(source).not.toMatch(/^['"]use client['"]/);
    expect(source).toContain("import { buildModelsList } from '@routeshift/shared'");
    expect(source).toContain('className="overflow-x-auto"');
    expect(source).toContain('min-w-[820px]');
  });

  it('renders embedding output pricing as not applicable on the public page', async () => {
    const embedding = buildModelsList(null).data.find(
      (model) => model.architecture?.modality === 'text->embedding',
    );
    expect(embedding).toBeDefined();
    if (!embedding) throw new Error('effective catalog has no embedding fixture');

    h.requireTeamMembership.mockResolvedValueOnce(null);
    render(await ModelsPage());
    const row = Array.from(document.querySelectorAll<HTMLTableRowElement>('tr[data-model-id]'))
      .find((candidate) => candidate.dataset.modelId === embedding.id);
    expect(row).toBeDefined();
    if (!row) throw new Error(`public row missing for ${embedding.id}`);

    expect(within(row).getByText('Not applicable')).toBeTruthy();
    expect(within(row).queryByText('$0.00 / 1M')).toBeNull();
  });

  it('labels explicit-only rows and does not offer chat routing actions for embeddings', () => {
    render(
      <ModelsTable
        models={[
          fixtureModel({ id: 'generated-chat' }),
          fixtureModel({ id: 'text-embedding-fixture', modality: 'text->embedding' }),
        ]}
      />,
    );

    const chatRow = screen.getByRole('row', { name: /generated-chat/i });
    expect(within(chatRow).getByText('Explicit only')).toBeTruthy();
    expect(within(chatRow).getByRole('link', { name: 'Use generated-chat explicitly in a routing rule' })).toBeTruthy();

    const embeddingRow = screen.getByRole('row', { name: /text-embedding-fixture/i });
    expect(within(embeddingRow).getByText('Catalog only')).toBeTruthy();
    expect(within(embeddingRow).queryByRole('link')).toBeNull();
    expect(within(embeddingRow).getByText('Not applicable')).toBeTruthy();
    expect(within(embeddingRow).queryByText('$0.00')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort models' }), {
      target: { value: 'cheapest_output' },
    });
    expect(
      Array.from(document.querySelectorAll<HTMLTableRowElement>('tr[data-model-id]'))
        .map((row) => row.dataset.modelId),
    ).toEqual(['generated-chat', 'text-embedding-fixture']);
  });
});

describe('/models/compare generated defaults', () => {
  it('uses generated current-role recommendations while preserving query overrides', async () => {
    const defaults = await CompareModelsPage({ searchParams: Promise.resolve({}) });
    expect(defaults.props.initialA).toBe(CURRENT_MODELS.default);
    expect(defaults.props.initialB).toBe(CURRENT_MODELS.reasoning);

    const overridden = await CompareModelsPage({
      searchParams: Promise.resolve({ a: 'manual-a', b: 'manual-b', period: '30d' }),
    });
    expect(overridden.props).toMatchObject({
      initialA: 'manual-a',
      initialB: 'manual-b',
      initialPeriod: '30d',
    });
  });
});
