import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_INDEX_SOURCE,
  isFreshSourceAsOf,
  isValidCapabilityIndices,
} from '../src/capability-sources';
import { MODEL_REGISTRY } from '../src/models';
import { buildModelDetail, buildModelsList } from '../src/catalog';
import type { ModelDefinition } from '../src/models';

// The catalog projection omits unpriced models; the synthetic surface-test
// models below need pricing rows to survive the gate.
vi.mock('../src/cost-tables', () => ({
  getModelPricing: () => ({ input_per_million: 1, output_per_million: 2 }),
}));

const SOURCE = 'OpenRouter model performance data (https://openrouter.ai/models)';

describe('isValidCapabilityIndices', () => {
  it('accepts a well-formed 0-100 index set with dated provenance', () => {
    expect(isValidCapabilityIndices({
      agentic: 87, coding: 91, intelligence: 84, source: SOURCE, source_as_of: '2026-08-10',
    })).toBe(true);
    expect(isValidCapabilityIndices({
      agentic: 0, coding: 100, intelligence: 50, source: SOURCE, source_as_of: new Date().toISOString(),
    })).toBe(true);
  });

  it('accepts PARTIAL axis sets (missing axis = honest no-signal, never fabricate)', () => {
    expect(isValidCapabilityIndices({
      agentic: 87, intelligence: 84, source: SOURCE, source_as_of: '2026-08-10',
    })).toBe(true);
    expect(isValidCapabilityIndices({
      coding: 91, source: SOURCE, source_as_of: '2026-08-10',
    })).toBe(true);
  });

  it('rejects sets with no measured axis at all', () => {
    expect(isValidCapabilityIndices({ source: SOURCE, source_as_of: '2026-08-10' })).toBe(false);
  });

  it('rejects out-of-range, non-finite, and non-number axes', () => {
    const base = { coding: 50, intelligence: 50, source: SOURCE, source_as_of: '2026-08-10' };
    expect(isValidCapabilityIndices({ ...base, agentic: -1 })).toBe(false);
    expect(isValidCapabilityIndices({ ...base, agentic: 101 })).toBe(false);
    expect(isValidCapabilityIndices({ ...base, agentic: Number.NaN })).toBe(false);
    expect(isValidCapabilityIndices({ ...base, agentic: '87' })).toBe(false);
    expect(isValidCapabilityIndices(null)).toBe(false);
    expect(isValidCapabilityIndices('nope')).toBe(false);
  });

  it('rejects unknown extra keys (they would be published verbatim)', () => {
    expect(isValidCapabilityIndices({
      agentic: 87, coding: 91, intelligence: 84, source: SOURCE, source_as_of: '2026-08-10', extra: 100,
    })).toBe(false);
  });

  it('rejects missing or unparseable provenance', () => {
    const base = { agentic: 87, coding: 91, intelligence: 84 };
    expect(isValidCapabilityIndices({ ...base, source: '', source_as_of: '2026-08-10' })).toBe(false);
    expect(isValidCapabilityIndices({ ...base, source: SOURCE, source_as_of: '' })).toBe(false);
    expect(isValidCapabilityIndices({ ...base, source: SOURCE, source_as_of: 'not-a-date' })).toBe(false);
  });

  it('rejects calendar-impossible dates that Date.parse silently normalizes', () => {
    // '2026-02-31' parses as 2026-03-03 — a typo'd provenance date must not
    // reach the public surface as if it were a real reading.
    const base = { agentic: 87, coding: 91, intelligence: 84, source: SOURCE };
    expect(isValidCapabilityIndices({ ...base, source_as_of: '2026-02-31' })).toBe(false);
    expect(isValidCapabilityIndices({ ...base, source_as_of: '2026-13-01' })).toBe(false);
    expect(isValidCapabilityIndices({ ...base, source_as_of: '2026-00-10' })).toBe(false);
    // the real calendar still passes
    expect(isValidCapabilityIndices({ ...base, source_as_of: '2026-02-28' })).toBe(true);
  });

  it('stays PURE: a parseable future date is accepted by the validator', () => {
    // wall-clock freshness is a GATE concern (isFreshSourceAsOf), not a
    // runtime one — the router's validator must not depend on Date.now()
    const future = { agentic: 87, coding: 91, intelligence: 84, source: SOURCE, source_as_of: '2099-01-01' };
    expect(isValidCapabilityIndices(future)).toBe(true);
    expect(isFreshSourceAsOf('2099-01-01')).toBe(false);
  });
});

describe('isFreshSourceAsOf (curation-time freshness)', () => {
  it('rejects future stamps and accepts past/date-only stamps', () => {
    expect(isFreshSourceAsOf('2099-01-01')).toBe(false);
    expect(isFreshSourceAsOf('2026-08-10')).toBe(true);
    expect(isFreshSourceAsOf(new Date().toISOString())).toBe(true);
  });
});

describe('registry provenance gate (RSH-143)', () => {
  /** Curation-time contract: values come from the declared source, are dated,
   *  fresh, and not stale (monthly re-verify documented in the source notes). */
  const MAX_SOURCE_AGE_MS = 60 * 24 * 60 * 60 * 1000;

  it('every model carrying indices passes the full provenance validation', () => {
    // This gate is the contract that will bite when the first defensible
    // claim lands: values 0-100, dated non-future source_as_of, citation.
    for (const m of MODEL_REGISTRY) {
      if (!m.capability_indices) continue;
      expect(isValidCapabilityIndices(m.capability_indices), `capability_indices on ${m.canonical_name}`).toBe(true);
    }
  });

  it('every populated set cites the declared source and is not stale', () => {
    for (const m of MODEL_REGISTRY) {
      const indices = m.capability_indices;
      if (!indices) continue;
      expect(indices.source, `source citation on ${m.canonical_name}`).toContain(CAPABILITY_INDEX_SOURCE.url);
      expect(isFreshSourceAsOf(indices.source_as_of), `future stamp on ${m.canonical_name}`).toBe(true);
      expect(
        Date.now() - Date.parse(indices.source_as_of) < MAX_SOURCE_AGE_MS,
        `stale stamp on ${m.canonical_name} (re-verify monthly)`,
      ).toBe(true);
    }
  });

  it('currently ships zero populated indices (no defensible source yet)', () => {
    // Honest-state pin: the OpenRouter source is OAuth-gated, so no model
    // carries indices today. This test flips when curation lands — it exists
    // so an accidental empty-vs-populated flip is a visible decision.
    const populated = MODEL_REGISTRY.filter((m) => m.capability_indices !== undefined);
    expect(populated).toEqual([]);
  });
});

describe('catalog surface (RSH-143)', () => {
  const withIndices: ModelDefinition = {
    provider: 'openai',
    canonical_name: 'cap-model',
    api_model_id: 'cap-model',
    context_window: 100_000,
    intelligence_tier: 3,
    capability_indices: { agentic: 90, coding: 95, intelligence: 85, source: SOURCE, source_as_of: '2026-08-10' },
  };

  it('carries sourced indices (with provenance) into /v1/models entries when present', () => {
    const list = buildModelsList(['cap-model'], [withIndices]);
    expect(list.data[0].capability_indices).toEqual({
      agentic: 90, coding: 95, intelligence: 85, source: SOURCE, source_as_of: '2026-08-10',
    });
    const detail = buildModelDetail('cap-model', null, [withIndices]);
    expect(detail?.capability_indices?.source_as_of).toBe('2026-08-10');
  });

  it('omits invalid/undated index sets from the surface (fail closed)', () => {
    const invalid: ModelDefinition = {
      provider: 'openai',
      canonical_name: 'bad-cap-model',
      api_model_id: 'bad-cap-model',
      context_window: 100_000,
      intelligence_tier: 3,
      capability_indices: { agentic: 90, coding: 95, intelligence: 85, source: SOURCE, source_as_of: '' },
    };
    const list = buildModelsList(['bad-cap-model'], [invalid]);
    expect(list.data[0]).toBeDefined();
    expect('capability_indices' in list.data[0]).toBe(false);
  });

  it('omits the field entirely when absent (undefined is not serialized)', () => {
    const list = buildModelsList(['gpt-5.4']);
    const entry = list.data.find((m) => m.id === 'gpt-5.4');
    expect(entry).toBeDefined();
    expect('capability_indices' in entry!).toBe(false);
    // and the wire payload has no trace of it
    expect(JSON.stringify(entry)).not.toContain('capability_indices');
  });

  it('returns a copy, so catalog consumers cannot mutate the registry', () => {
    const list = buildModelsList(['cap-model'], [withIndices]);
    list.data[0].capability_indices!.agentic = 1;
    expect(withIndices.capability_indices!.agentic).toBe(90);
  });
});
