import { describe, it, expect } from 'vitest';
import {
  applyPromotion,
  buildPromotion,
  findEntryLines,
  pricingRowTemplate,
  run,
} from '../scripts/promote-model.js';

// Synthetic models.ts fixtures — no network, no real file writes. The parked
// entries mirror the exact one-line format used in src/models.ts.
const FIXTURE = `export const MODEL_REGISTRY: ModelDefinition[] = [
  { provider: 'openai', canonical_name: 'gpt-9-public', api_model_id: 'gpt-9-public', context_window: 1_000_000, intelligence_tier: 3 },
  { provider: 'zai', canonical_name: 'grok-9-parked', api_model_id: 'grok-9-parked', context_window: 256_000, auto_route: false, public: false, intelligence_tier: 2 },
  { provider: 'minimax', canonical_name: 'deepseek-parked', api_model_id: 'deepseek-parked-api', context_window: 128_000, auto_route: false, public: false },
  { provider: 'xai', canonical_name: 'grok-unroutable', api_model_id: 'grok-unroutable', context_window: 256_000, auto_route: false, public: false },
  { provider: 'notaprovider', canonical_name: 'rogue-1', api_model_id: 'rogue-1', context_window: 128_000, auto_route: false, public: false },
  // ── Auto-proposed parked candidates (detect-models 2026-08-06) — inert until promoted. ──
  { provider: 'moonshot', canonical_name: 'kimi-k9', api_model_id: 'kimi-k9', context_window: 256_000, auto_route: false, public: false },
];
`;

const PRICED = () => ({
  provider: 'x',
  model: 'y',
  input_per_million: 1,
  output_per_million: 2,
});
const UNPRICED = () => null;

describe('findEntryLines', () => {
  it('matches canonical_name exactly, case-insensitive', () => {
    const hit = findEntryLines(FIXTURE, 'GROK-9-PARKED')[0];
    expect(hit?.canonicalName).toBe('grok-9-parked');
    expect(hit?.provider).toBe('zai');
    expect(hit?.parked).toBe(true);
    expect(hit?.autoRouteDisabled).toBe(true);
  });

  it('matches api_model_id too', () => {
    const hit = findEntryLines(FIXTURE, 'deepseek-parked-api')[0];
    expect(hit?.canonicalName).toBe('deepseek-parked');
  });

  it('returns null for unknown models', () => {
    expect(findEntryLines(FIXTURE, 'no-such-model')).toEqual([]);
  });

  it('does not substring-match other entries', () => {
    expect(findEntryLines(FIXTURE, 'grok-9')).toEqual([]);
  });

  it('flags already-public entries as not parked', () => {
    const hit = findEntryLines(FIXTURE, 'gpt-9-public')[0];
    expect(hit?.parked).toBe(false);
    expect(hit?.autoRouteDisabled).toBe(false);
  });
});

describe('buildPromotion', () => {
  const line =
    "  { provider: 'zai', canonical_name: 'grok-9-parked', api_model_id: 'grok-9-parked', context_window: 256_000, auto_route: false, public: false, intelligence_tier: 2 },";

  it('removes public: false and keeps every other field', () => {
    const out = buildPromotion(line, {});
    expect(out).not.toContain('public: false');
    expect(out).toContain("auto_route: false");
    expect(out).toContain("provider: 'zai'");
    expect(out).toContain('context_window: 256_000');
    expect(out).toContain('intelligence_tier: 2');
    expect(out).not.toContain(',,');
  });

  it('with autoRoute removes both flags', () => {
    const out = buildPromotion(line, { autoRoute: true });
    expect(out).not.toContain('public: false');
    expect(out).not.toContain('auto_route: false');
    expect(out).not.toContain(',,');
  });

  it('keeps the `{ ` shape when public: false is the first field', () => {
    const firstField =
      "  { public: false, provider: 'zai', canonical_name: 'z-9', api_model_id: 'z-9', context_window: 3 },";
    const out = buildPromotion(firstField, {});
    expect(out).not.toContain('public: false');
    expect(out).toContain("{ provider: 'zai'");
    expect(out).not.toContain('{provider');
  });

  it('handles a trailing public: false (flag last before the brace)', () => {
    const trailing =
      "  { provider: 'moonshot', canonical_name: 'kimi-k9', api_model_id: 'kimi-k9', context_window: 256_000, auto_route: false, public: false },";
    const out = buildPromotion(trailing, {});
    expect(out).not.toContain('public: false');
    expect(out).toContain("auto_route: false }");
    expect(out).not.toContain(',,');
    expect(out).not.toContain(', }');
  });
});

describe('applyPromotion', () => {
  it('promotes a parked entry in place, preserving line position and other lines', () => {
    const result = applyPromotion(FIXTURE, 'grok-9-parked', { pricingLookup: PRICED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const beforeLines = FIXTURE.split('\n');
    const afterLines = result.source.split('\n');
    expect(afterLines.length).toBe(beforeLines.length);
    expect(afterLines[result.entry.lineIndex]).toBe(result.entryLine);
    // Every other line is byte-identical.
    for (let i = 0; i < beforeLines.length; i++) {
      if (i !== result.entry.lineIndex) expect(afterLines[i]).toBe(beforeLines[i]);
    }
    expect(result.entryLine).not.toContain('public: false');
    expect(result.entryLine).toContain('auto_route: false');
  });

  it('does not mutate the input source string', () => {
    applyPromotion(FIXTURE, 'grok-9-parked', { pricingLookup: PRICED });
    expect(FIXTURE).toContain("canonical_name: 'grok-9-parked'");
  });

  it('refuses an unknown model', () => {
    const result = applyPromotion(FIXTURE, 'no-such-model', { pricingLookup: PRICED });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not-found');
    expect(result.message).toContain('no-such-model');
  });

  it('refuses an already-public entry', () => {
    const result = applyPromotion(FIXTURE, 'gpt-9-public', { pricingLookup: PRICED });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('already-public');
  });

  it('refuses an entry whose provider has no registered runtime adapter', () => {
    // xai is in PROVIDERS (catalog) but in PROVIDERS_WITHOUT_RUNTIME_ADAPTER:
    // promoting would mint a publicly-listed model that 400s "Unknown provider"
    // on every request, and drop it out of the parked regression guard.
    const result = applyPromotion(FIXTURE, 'grok-unroutable', { pricingLookup: PRICED });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-provider');
    expect(result.message).toContain('runtime adapter');
    expect(result.message).toContain("'xai'");
  });

  it('refuses an entry whose provider is not in PROVIDERS', () => {
    const result = applyPromotion(FIXTURE, 'rogue-1', { pricingLookup: PRICED });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-provider');
    expect(result.message).toContain('notaprovider');
  });

  it('flags unpriced models with a paste-template instead of promoting silently', () => {
    const result = applyPromotion(FIXTURE, 'kimi-k9', { pricingLookup: UNPRICED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.priced).toBe(false);
    expect(result.pricingTemplate).toContain("provider: 'moonshot'");
    expect(result.pricingTemplate).toContain("model: 'kimi-k9'");
    // Non-Anthropic rule from cost-tables.ts comments.
    expect(result.pricingTemplate).toContain('cache_write_per_million: 0');
  });

  it('checks pricing by api_model_id as a fallback', () => {
    const calls: Array<[string, string]> = [];
    const result = applyPromotion(FIXTURE, 'deepseek-parked', {
      pricingLookup: (p, m) => {
        calls.push([p, m]);
        return m === 'deepseek-parked-api' ? PRICED() : null;
      },
    });
    expect(result.ok && result.priced).toBe(true);
    expect(calls).toContainEqual(['minimax', 'deepseek-parked']);
    expect(calls).toContainEqual(['minimax', 'deepseek-parked-api']);
  });
});

describe('pricingRowTemplate', () => {
  it('omits the cache_write_per_million: 0 row field for Anthropic', () => {
    const template = pricingRowTemplate('anthropic', 'claude-new-9');
    expect(template).not.toMatch(/cache_write_per_million:\s*0/);
    expect(template).toContain("provider: 'anthropic'");
  });
});

describe('run (CLI)', () => {
  function harness(argv: string[], pricingLookup: typeof PRICED | typeof UNPRICED = PRICED) {
    const writes: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const code = run(argv, {
      readSource: () => FIXTURE,
      writeSource: (content) => writes.push(content),
      pricingLookup,
      log: (m) => out.push(m),
      error: (m) => err.push(m),
    });
    return { code, writes, out, err };
  }

  it('promotes and writes the edited source', () => {
    const { code, writes } = harness(['grok-9-parked']);
    expect(code).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).not.toContain("canonical_name: 'grok-9-parked', api_model_id: 'grok-9-parked', context_window: 256_000, auto_route: false, public: false");
    expect(writes[0]).toContain("canonical_name: 'grok-9-parked'");
    expect(writes[0]).toContain("public: false"); // other parked entries untouched
  });

  it('--auto-route removes both flags in the written source', () => {
    const { code, writes } = harness(['grok-9-parked', '--auto-route']);
    expect(code).toBe(0);
    const line = writes[0].split('\n').find((l) => l.includes('grok-9-parked'));
    expect(line).not.toContain('public: false');
    expect(line).not.toContain('auto_route: false');
  });

  it('--dry-run prints the resulting entry line and writes nothing', () => {
    const { code, writes, out } = harness(['grok-9-parked', '--dry-run']);
    expect(code).toBe(0);
    expect(writes).toHaveLength(0);
    const printed = out.find((m) => m.includes('grok-9-parked'));
    expect(printed).toBeTruthy();
    expect(printed).not.toContain('public: false');
  });

  it('refuses an unpriced promotion: non-zero exit, nothing written, template on stderr', () => {
    const { code, writes, err } = harness(['kimi-k9'], UNPRICED);
    expect(code).toBe(1);
    expect(writes).toHaveLength(0);
    const joined = err.join('\n');
    expect(joined).toContain('UNPRICED');
    expect(joined).toContain("provider: 'moonshot'");
    expect(joined).toContain('cache_write_per_million: 0');
  });

  it('refuses unknown models with non-zero exit', () => {
    const { code, writes, err } = harness(['no-such-model']);
    expect(code).toBe(1);
    expect(writes).toHaveLength(0);
    expect(err.join('\n')).toContain('no-such-model');
  });

  it('refuses already-public entries with non-zero exit', () => {
    const { code, writes } = harness(['gpt-9-public']);
    expect(code).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('refuses non-PROVIDERS providers with non-zero exit', () => {
    const { code, writes } = harness(['rogue-1']);
    expect(code).toBe(1);
    expect(writes).toHaveLength(0);
  });

  it('prints usage and exits 2 without a model name', () => {
    const { code, err } = harness([]);
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('Usage:');
  });
});

describe('ambiguity + format guards (review round 1)', () => {
  const AMBIGUOUS = `export const MODEL_REGISTRY: ModelDefinition[] = [
  { provider: 'openai', canonical_name: 'gpt-9', api_model_id: 'gpt-9', context_window: 128_000, auto_route: false, public: false },
  { provider: 'azure', canonical_name: 'azure-gpt-9', api_model_id: 'gpt-9', context_window: 128_000, auto_route: false, public: false },
];
`;

  it('refuses when a name matches entries for more than one provider', () => {
    const result = applyPromotion(AMBIGUOUS, 'gpt-9', { pricingLookup: PRICED });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ambiguous');
    expect(result.message).toContain('openai/gpt-9');
    expect(result.message).toContain('azure/azure-gpt-9');
  });

  it('refuses multi-line entries loudly instead of mis-promoting', () => {
    const multiline = `export const MODEL_REGISTRY: ModelDefinition[] = [
  { provider: 'xai', canonical_name: 'grok-9-parked',
    api_model_id: 'grok-9-parked', context_window: 256_000,
    auto_route: false, public: false },
];
`;
    const result = applyPromotion(multiline, 'grok-9-parked', { pricingLookup: PRICED });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported-format');
  });

  it('promoting without --auto-route preserves the parked routing posture when the flag is absent', () => {
    const noAutoRouteFlag = `export const MODEL_REGISTRY: ModelDefinition[] = [
  { provider: 'zai', canonical_name: 'grok-9-parked', api_model_id: 'grok-9-parked', context_window: 256_000, public: false },
];
`;
    // Absence of auto_route:false means the auto-router WOULD route the model;
    // a plain "make public" must not silently enable routing.
    const result = applyPromotion(noAutoRouteFlag, 'grok-9-parked', { pricingLookup: PRICED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entryLine).not.toMatch(/\bpublic:\s*false\b/);
    expect(result.entryLine).toMatch(/\bauto_route:\s*false\b/);
  });

  it('tolerates whitespace-variant flags and verifies the flag is actually gone', () => {
    const variant = `export const MODEL_REGISTRY: ModelDefinition[] = [
  { provider: 'zai', canonical_name: 'grok-9-parked', api_model_id: 'grok-9-parked', context_window: 256_000, auto_route:  false,  public:  false },
];
`;
    const result = applyPromotion(variant, 'grok-9-parked', { pricingLookup: PRICED });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entryLine).not.toMatch(/\bpublic:\s*false\b/);
    expect(result.entryLine).toMatch(/\bauto_route:\s*false\b/);
  });

  it('zero-rate rows are not pricing (except documented subscription providers)', () => {
    const ZERO = () => ({ provider: 'x', model: 'y', input_per_million: 0, output_per_million: 0 });
    const zeroFixture = `export const MODEL_REGISTRY: ModelDefinition[] = [
  { provider: 'zai', canonical_name: 'grok-9-parked', api_model_id: 'grok-9-parked', context_window: 256_000, auto_route: false, public: false },
  { provider: 'xiaomi', canonical_name: 'mimo-9-parked', api_model_id: 'mimo-9-parked', context_window: 128_000, auto_route: false, public: false },
];
`;
    const refused = applyPromotion(zeroFixture, 'grok-9-parked', { pricingLookup: ZERO });
    expect(refused.ok).toBe(true);
    if (!refused.ok) return;
    expect(refused.priced).toBe(false);
    // Xiaomi's curated rows are deliberately zero-rated (subscription Token
    // Plan, cost-tables.ts) — that IS the pricing contract there.
    const allowed = applyPromotion(zeroFixture, 'mimo-9-parked', { pricingLookup: ZERO });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.priced).toBe(true);
  });

  it('field extraction ignores lookalike prefixes (default_provider)', () => {
    const lookalike = `export const MODEL_REGISTRY: ModelDefinition[] = [
  { provider: 'xai', canonical_name: 'grok-9-parked', api_model_id: 'grok-9-parked', context_window: 256_000, auto_route: false, public: false }, // default_provider: 'evil'
];
`;
    const hit = findEntryLines(lookalike, 'grok-9-parked')[0];
    expect(hit?.provider).toBe('xai');
  });
});

describe('round-2 guards', () => {
  it('appends auto_route: false even with no space before the closing brace', () => {
    // Hand-edited variant: `..._000, public: false},` — the round-1 append
    // regex required whitespace before `}` and silently skipped the append,
    // producing a public + auto-routable entry (agy/glm/opus, review round 2).
    const NO_SPACE =
      "export const MODEL_REGISTRY: ModelDefinition[] = [\n" +
      "  { provider: 'zai', canonical_name: 'grok-9-parked', api_model_id: 'grok-9-parked', context_window: 256_000, public: false},\n" +
      "];\n";
    const out = applyPromotion(NO_SPACE, 'grok-9-parked', { pricingLookup: () => null });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.source).toContain("context_window: 256_000, auto_route: false },");
      expect(out.source).not.toContain('public: false');
    }
  });

  it('refuses a parked entry carrying explicit auto_route: true (contradictory posture)', () => {
    // Appending would emit a duplicate auto_route key (invalid TS); flipping
    // it is a routing decision the tool must not guess (kimi, review round 2).
    const CONTRADICTORY =
      "export const MODEL_REGISTRY: ModelDefinition[] = [\n" +
      "  { provider: 'zai', canonical_name: 'grok-x', api_model_id: 'grok-x', context_window: 1_000, auto_route: true, public: false },\n" +
      "];\n";
    const out = applyPromotion(CONTRADICTORY, 'grok-x', { pricingLookup: () => null });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('unsupported-format');
  });

  it('a name mentioned only in a comment is not-found, not multi-line', () => {
    // quotedElsewhere scans code, not comments — a doc reference must not
    // misdiagnose a genuinely absent entry as "promote by hand" (nw-kimi, review round 2).
    const COMMENT_ONLY =
      "// grok-9-parked was considered and rejected\n" +
      "export const MODEL_REGISTRY: ModelDefinition[] = [\n" +
      "  { provider: 'openai', canonical_name: 'gpt-9-public', api_model_id: 'gpt-9-public', context_window: 1_000_000 },\n" +
      "];\n";
    const out = applyPromotion(COMMENT_ONLY, 'grok-9-parked', { pricingLookup: () => null });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('not-found');
  });
});
