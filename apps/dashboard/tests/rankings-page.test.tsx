// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_FRESHNESS_MANIFEST,
  type CapabilityIndices,
  type CatalogModel,
} from '@routeshift/shared';
import RankingsPage from '@/app/rankings/page';
import {
  rankCapability,
  rankCheapestInput,
  rankCheapestOutput,
  rankLargestContext,
} from '@/lib/model-rankings';

vi.mock('motion/react', () => ({
  motion: new Proxy({}, {
    get: (_target, tag: string) => ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => {
      const { initial: _initial, animate: _animate, transition: _transition, ...htmlProps } = props;
      return createElement(tag, htmlProps, children);
    },
  }),
}));

function catalogModel({
  id,
  provider,
  prompt,
  completion,
  context,
  capability,
  embedding = false,
}: {
  id: string;
  provider: string;
  prompt: number;
  completion: number;
  context: number;
  capability?: CapabilityIndices;
  embedding?: boolean;
}): CatalogModel {
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: provider,
    name: id,
    context_length: context,
    pricing: { prompt: String(prompt), completion: String(completion) },
    ...(embedding ? {
      architecture: {
        modality: 'text->embedding',
        input_modalities: ['text'],
        output_modalities: ['embedding'],
      },
    } : {}),
    ...(capability ? { capability_indices: capability } : {}),
    catalog: { source: 'curated', routing: 'auto_or_explicit' },
    endpoints: [],
  };
}

const SOURCE = {
  source: 'Fixture capability source https://example.test/capabilities',
  source_as_of: '2026-08-20',
} as const;

const FIXTURE = [
  catalogModel({ id: 'zeta', provider: 'beta', prompt: 1, completion: 4, context: 200_000, capability: { agentic: 90, ...SOURCE } }),
  catalogModel({ id: 'alpha', provider: 'alpha', prompt: 1, completion: 2, context: 200_000, capability: { agentic: 90, coding: 80, ...SOURCE } }),
  catalogModel({ id: 'gamma', provider: 'alpha', prompt: 3, completion: 2, context: 100_000, capability: { coding: 95, ...SOURCE } }),
  catalogModel({ id: 'zero-priced', provider: 'alpha', prompt: 0, completion: 0, context: 500_000 }),
  catalogModel({ id: 'embedding', provider: 'alpha', prompt: 0.5, completion: 0, context: 8_192, embedding: true }),
] as const;

afterEach(() => cleanup());

describe('deterministic model rankings', () => {
  it('ranks positive input and output prices with provider and ID tie-breakers', () => {
    expect(rankCheapestInput(FIXTURE).map((model) => model.id)).toEqual([
      'embedding',
      'alpha',
      'zeta',
      'gamma',
    ]);
    expect(rankCheapestOutput(FIXTURE).map((model) => model.id)).toEqual([
      'alpha',
      'gamma',
      'zeta',
    ]);
  });

  it('ranks context descending with deterministic ties', () => {
    expect(rankLargestContext(FIXTURE).map((model) => model.id)).toEqual([
      'zero-priced',
      'alpha',
      'zeta',
      'gamma',
      'embedding',
    ]);
  });

  it('ranks only sourced capability values and keeps their provenance', () => {
    const agentic = rankCapability(FIXTURE, 'agentic');
    expect(agentic.map((model) => model.id)).toEqual(['alpha', 'zeta']);
    expect(agentic.every((model) => model.capability_indices?.source === SOURCE.source)).toBe(true);

    expect(rankCapability(FIXTURE, 'coding').map((model) => model.id)).toEqual([
      'gamma',
      'alpha',
    ]);
    expect(rankCapability(FIXTURE, 'intelligence')).toEqual([]);
  });
});

describe('rankings page', () => {
  it('renders model-only catalog calculations with methodology and generated time', () => {
    render(<RankingsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Model rankings' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cheapest input' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cheapest output' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Largest context' })).toBeTruthy();
    expect(screen.getByText(/Prices sort ascending; context and sourced capability indices sort descending/i)).toBeTruthy();
    expect(document.querySelector(`time[datetime="${CATALOG_FRESHNESS_MANIFEST.generated_at}"]`)).toBeTruthy();

    expect(screen.queryByRole('button', { name: /apps/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /agents/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /GPT-5\.5/i })).toBeNull();
  });

  it('omits capability tables when the effective catalog has no sourced values', () => {
    render(<RankingsPage />);

    expect(screen.queryByRole('heading', { name: 'Agentic capability' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Coding capability' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Intelligence capability' })).toBeNull();
  });
});
