import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyProposals,
  buildEntries,
  computeProposals,
  filterCandidates,
  loadExclusions,
  notExcluded,
} from '../scripts/propose-parked-models.js';
import type { DiscoveredModel } from '../scripts/detect-model-drift.js';
import type { LiteLLMEntry } from '../scripts/litellm-source.js';
import { MODEL_REGISTRY } from '../src/models.js';

// Deterministic, no-network: hand-built LiteLLM catalog diffed against the REAL
// registry (same approach as detect-model-drift.test.ts). Ids use a `cenprop9`
// suffix so they certainly are not in the registry and extend an existing
// family at a token boundary (sameFamily match).
// A tracked family OUTSIDE the proxy's prefix-passthrough set (gpt-*/o3*/
// o4*/claude-*/gemini-*): passthrough-covered ids are correctly filtered from
// proposals (round 4), so fixtures must extend a non-passthrough family.
const existing = MODEL_REGISTRY.find(
  (m) =>
    m.provider === 'moonshot' &&
    !/^(gpt-|o3|o4|claude-|gemini-)/.test(m.api_model_id),
) ?? MODEL_REGISTRY[0];
const existingLiteLLMProvider = existing.provider === 'google' ? 'gemini' : existing.provider;

const chat = (max_input_tokens?: number): LiteLLMEntry => ({
  litellm_provider: existingLiteLLMProvider,
  mode: 'chat',
  ...(max_input_tokens === undefined ? {} : { max_input_tokens }),
});

const trackedNew: DiscoveredModel = {
  provider: existing.provider,
  model: `${existing.api_model_id}-cenprop9`,
  kind: 'chat',
  context_window: 500000,
};

const fixtureCatalog: Record<string, LiteLLMEntry> = {
  // proposed: new chat variant of a tracked family, sane context window
  [trackedNew.model]: chat(500000),
  // (a) modality denylist
  [`${existing.api_model_id}-audio-preview`]: chat(128000),
  [`${existing.api_model_id}-tts-hd`]: chat(128000),
  [`${existing.api_model_id}-realtime`]: chat(128000),
  [`${existing.api_model_id}-image-gen`]: chat(128000),
  // (b) context_window must be positive and finite
  [`${existing.api_model_id}-cenzeroctx9`]: chat(0),
  [`${existing.api_model_id}-cennoctx9`]: chat(),
  // (c) long tail: proxied provider, but NOT a family we carry
  'totally-novel-family-cenprop9': { litellm_provider: 'openai', mode: 'chat', max_input_tokens: 128000 },
  // embedding drift is never proposed into the chat registry
  [`${existing.api_model_id}-cenemb9`]: {
    litellm_provider: existingLiteLLMProvider,
    mode: 'embedding',
    max_input_tokens: 8192,
  },
};

describe('computeProposals / filterCandidates', () => {
  it('proposes a new chat model in a tracked family', () => {
    const proposals = computeProposals(fixtureCatalog);
    expect(proposals).toEqual([trackedNew]);
  });

  it('filters audio/tts/realtime/image ids (modality denylist)', () => {
    const audioy: DiscoveredModel[] = [
      { provider: 'openai', model: 'gpt-5.5-audio-preview', kind: 'chat', context_window: 128000 },
      { provider: 'openai', model: 'gpt-5.5-tts', kind: 'chat', context_window: 128000 },
      { provider: 'openai', model: 'gpt-5.5-realtime', kind: 'chat', context_window: 128000 },
      { provider: 'openai', model: 'dall-e-4', kind: 'chat', context_window: 128000 },
      { provider: 'openai', model: 'whisper-2', kind: 'chat', context_window: 128000 },
    ];
    expect(filterCandidates(audioy)).toEqual([]);
  });

  it('filters context_window 0 / missing / non-finite', () => {
    const bad: DiscoveredModel[] = [
      { provider: 'openai', model: 'm-zero', kind: 'chat', context_window: 0 },
      { provider: 'openai', model: 'm-null', kind: 'chat', context_window: null },
      { provider: 'openai', model: 'm-nan', kind: 'chat', context_window: Number.NaN },
      { provider: 'openai', model: 'm-inf', kind: 'chat', context_window: Number.POSITIVE_INFINITY },
    ];
    expect(filterCandidates(bad)).toEqual([]);
  });

  it('never proposes the long tail (only newInTrackedFamily feeds filterCandidates)', () => {
    const proposals = computeProposals(fixtureCatalog);
    expect(proposals.some((m) => m.model === 'totally-novel-family-cenprop9')).toBe(false);
  });

  it('never proposes embedding-kind models into MODEL_REGISTRY', () => {
    const proposals = computeProposals(fixtureCatalog);
    expect(proposals.every((m) => m.kind === 'chat')).toBe(true);
  });
});

describe('buildEntries', () => {
  it('matches the exact contract entry format', () => {
    const [entry] = buildEntries([trackedNew]);
    expect(entry).toBe(
      `  { provider: '${existing.provider}', canonical_name: '${trackedNew.model}', ` +
        `api_model_id: '${trackedNew.model}', context_window: 500_000, auto_route: false, public: false },`,
    );
    const contract =
      /^  \{ provider: '[a-z]+', canonical_name: '[^']+', api_model_id: '[^']+', context_window: \d[\d_]*, auto_route: false, public: false \},$/;
    expect(entry).toMatch(contract);
  });

  it('underscore-separates large context windows', () => {
    const [entry] = buildEntries([{ ...trackedNew, context_window: 1000000 }]);
    expect(entry).toContain('context_window: 1_000_000,');
  });
});

describe('applyProposals', () => {
  const TEST_DIR = dirname(fileURLToPath(import.meta.url));
  const realSource = readFileSync(join(TEST_DIR, '..', 'src', 'models.ts'), 'utf8');

  it('returns the source unchanged when there are no entries', () => {
    expect(applyProposals(realSource, [], '2026-08-06')).toBe(realSource);
  });

  it('inserts a dated auto-proposed section before the closing ]; of MODEL_REGISTRY', () => {
    const entries = buildEntries([trackedNew]);
    const out = applyProposals(realSource, entries, '2026-08-06');

    const header = '// ── Auto-proposed parked candidates (detect-models 2026-08-06) — inert until promoted. ──';
    const headerIdx = out.indexOf(header);
    expect(headerIdx).toBeGreaterThan(-1);
    const entryIdx = out.indexOf(entries[0]);
    expect(entryIdx).toBeGreaterThan(headerIdx);
    // The inserted section lands INSIDE the array, just before its closing bracket.
    const closingIdx = out.indexOf('\n];', headerIdx);
    expect(closingIdx).toBeGreaterThan(entryIdx);
    // Nothing after the closing bracket was disturbed.
    expect(out.slice(closingIdx)).toBe(realSource.slice(realSource.indexOf('\n];')));
  });

  it('appends a NEW dated section even when a prior auto-proposed section exists', () => {
    const once = applyProposals(realSource, buildEntries([trackedNew]), '2026-08-01');
    const second: DiscoveredModel = { ...trackedNew, model: `${existing.api_model_id}-cenprop9b` };
    const twice = applyProposals(once, buildEntries([second]), '2026-08-06');
    expect(twice).toContain('(detect-models 2026-08-01)');
    expect(twice).toContain('(detect-models 2026-08-06)');
    expect(twice.indexOf('(detect-models 2026-08-01)')).toBeLessThan(
      twice.indexOf('(detect-models 2026-08-06)'),
    );
  });

  it('throws a clear error when MODEL_REGISTRY cannot be located', () => {
    expect(() => applyProposals('export const OTHER = [\n];\n', ['x'], '2026-08-06')).toThrow(
      /MODEL_REGISTRY/,
    );
  });
});

describe('real-registry idempotence', () => {
  it('after applying proposals to the real models.ts source, the id is in the registry source (no longer new)', () => {
    const TEST_DIR = dirname(fileURLToPath(import.meta.url));
    const realSource = readFileSync(join(TEST_DIR, '..', 'src', 'models.ts'), 'utf8');

    const proposals = computeProposals(fixtureCatalog);
    expect(proposals).toEqual([trackedNew]);
    const out = applyProposals(realSource, buildEntries(proposals), '2026-08-06');

    // computeDrift's known-id set is built from canonical_name + api_model_id
    // (case-insensitive) — both now appear in the source, so a re-run of the
    // same catalog would report zero newInTrackedFamily for this id.
    expect(out.toLowerCase()).toContain(`canonical_name: '${trackedNew.model.toLowerCase()}'`);
    expect(out.toLowerCase()).toContain(`api_model_id: '${trackedNew.model.toLowerCase()}'`);
    // And the registry guard's membership test passes on the patched source.
    const knownIds = new Set(
      [...out.matchAll(/canonical_name: '([^']+)'/g)].map((m) => m[1].toLowerCase()),
    );
    expect(knownIds.has(trackedNew.model.toLowerCase())).toBe(true);
  });
});

describe('supply-chain guards (review round 1)', () => {
  it('drops catalog ids with unsafe charsets (TS-injection vector)', () => {
    const hostile: DiscoveredModel[] = [
      // Breaks out of the single-quoted literal:
      { provider: 'openai', model: `gpt-9', evil: true, x: '`, kind: 'chat', context_window: 128000 },
      // Newline escapes the line entirely:
      { provider: 'openai', model: 'gpt-9\n}, { provider: \'openai\', canonical_name: \'rogue\', api_model_id: \'rogue\', context_window: 1 } , //', kind: 'chat', context_window: 128000 },
      // Braces/commas/spaces that could rebalance the object:
      { provider: 'openai', model: "gpt-9' }, { provider: 'openai', canonical_name: 'rogue', api_model_id: 'rogue', context_window: 1, auto_route: true, public: true }, //", kind: 'chat', context_window: 128000 },
      { provider: 'evil corp', model: 'gpt-9', kind: 'chat', context_window: 128000 },
    ];
    expect(filterCandidates(hostile)).toEqual([]);
  });

  it('anchors insertion on the DECLARATION, not an earlier textual mention', () => {
    // A comment, an alias const whose name CONTAINS MODEL_REGISTRY, and an
    // earlier-closed array all appear before the real declaration. The entries
    // must land in the real MODEL_REGISTRY array only.
    const decoy = `// MODEL_REGISTRY is the chat catalog.
export const MODEL_REGISTRY_ALIASES: Record<string, string> = {};
export const PROVIDERS = [
  'openai',
];

export const MODEL_REGISTRY: ModelDefinition[] = [
  { provider: 'openai', canonical_name: 'gpt-9', api_model_id: 'gpt-9', context_window: 128_000, auto_route: false, public: false },
];
`;
    const entries = buildEntries([trackedNew]);
    const out = applyProposals(decoy, entries, '2026-08-06');
    const declIdx = out.indexOf('export const MODEL_REGISTRY:');
    const entryIdx = out.indexOf(entries[0]);
    expect(entryIdx).toBeGreaterThan(declIdx);
    // The earlier PROVIDERS array is untouched.
    expect(out.indexOf("'openai',\n];")).toBeLessThan(declIdx);
  });

  it('groups context windows deterministically (no ICU dependency)', () => {
    expect(buildEntries([{ ...trackedNew, context_window: 200000 }])[0]).toContain('context_window: 200_000,');
    expect(buildEntries([{ ...trackedNew, context_window: 1048576 }])[0]).toContain('context_window: 1_048_576,');
    expect(buildEntries([{ ...trackedNew, context_window: 65536 }])[0]).toContain('context_window: 65_536,');
  });
});

describe('round-2 guards', () => {
  it('drops non-integer and absurd context windows', () => {
    // 1e21 survives Number.isFinite but stringifies as `1e+21` (nonsense
    // registry data); fractional windows are catalog junk (nw-kimi, round 2).
    const junk: DiscoveredModel[] = [
      { provider: 'openai', model: 'm-huge', kind: 'chat', context_window: 1e21 },
      { provider: 'openai', model: 'm-frac', kind: 'chat', context_window: 500_000.5 },
      { provider: 'openai', model: 'm-max-ok', kind: 'chat', context_window: 32_000_000 },
    ];
    expect(filterCandidates(junk).map((m) => m.model)).toEqual(['m-max-ok']);
  });

  it('loadExclusions parses a JSON string array, lowercased; missing file = empty', () => {
    expect(loadExclusions('/nonexistent/path.json').size).toBe(0);
    const tmp = join(tmpdir(), 'propose-parked-exclusions-test.json');
    writeFileSync(tmp, JSON.stringify(['OpenAI/GPT-9-Cenprop9', 'other-model']));
    const ex = loadExclusions(tmp);
    expect(ex.has('openai/gpt-9-cenprop9')).toBe(true);
    expect(ex.has('other-model')).toBe(true);
  });
});

describe('round-3 guards', () => {
  it('notExcluded filters human-rejected candidates end-to-end (bare id and provider/model, case-insensitive)', () => {
    const mk = (provider: string, model: string): DiscoveredModel => ({
      provider,
      model,
      kind: 'chat',
      context_window: 1000,
    });
    const candidates = [mk('openai', 'gpt-9-cenop9'), mk('moonshot', 'Kimi-K9'), mk('bedrock', 'nova-2')];
    const exclusions = new Set(['gpt-9-cenop9', 'moonshot/kimi-k9']);
    const kept = notExcluded(candidates, exclusions);
    expect(kept.map((m) => `${m.provider}/${m.model}`)).toEqual(['bedrock/nova-2']);
    // Empty exclusion set is the fast path and must keep everything.
    expect(notExcluded(candidates, new Set()).length).toBe(3);
  });

  it('loadExclusions throws on unreadable paths (only ENOENT degrades to empty)', () => {
    // A directory path exists but cannot be read as a file (EISDIR) — a
    // silent empty set here would re-propose every human-rejected candidate.
    const dirPath = dirname(fileURLToPath(import.meta.url));
    expect(() => loadExclusions(dirPath)).toThrow();
  });

  it('computeProposals ordering is ordinal (locale/ICU-independent) across case and punctuation', () => {
    // All in the same tracked family, so the sort reduces to the model id.
    // Ordinal byte order: '-' (45) < '.' (46) < 'B' (66) < 'b' (98); a
    // locale-aware comparator may interleave case differently per ICU build.
    // (Distinct lowercase forms: the drift dedupe is case-insensitive, so
    // case-only twins would collide upstream of the sort.)
    const base = existing.api_model_id;
    const catalog: Record<string, LiteLLMEntry> = {
      [`${base}-cenprop9-b2`]: chat(500000),
      [`${base}-cenprop9.a3`]: chat(500000),
      [`${base}-cenprop9-B1`]: chat(500000),
    };
    const proposals = computeProposals(catalog);
    expect(proposals.map((p) => p.model)).toEqual([
      `${base}-cenprop9-B1`,
      `${base}-cenprop9-b2`,
      `${base}-cenprop9.a3`,
    ]);
  });
});

describe('round-4 guards', () => {
  it('drops candidates covered by the proxy prefix passthrough (parking would revoke working requests)', () => {
    // resolveProvider dispatches unknown gpt-*/claude-*/gemini-*/o3*/o4* ids
    // by prefix, so these work day-one; parking them would 400 live traffic.
    const mk = (provider: string, model: string): DiscoveredModel => ({
      provider,
      model,
      kind: 'chat',
      context_window: 1000,
    });
    const input = [
      mk('openai', 'gpt-9.9'),
      mk('openai', 'o3-deep'),
      mk('anthropic', 'claude-opus-9'),
      mk('google', 'gemini-9-pro'),
      mk('moonshot', 'kimi-k9'),
      mk('zai', 'glm-9'),
    ];
    const kept = filterCandidates(input);
    expect(kept.map((m) => m.model)).toEqual(['kimi-k9', 'glm-9']);
  });
});
