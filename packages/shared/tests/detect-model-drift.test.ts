import { describe, it, expect } from 'vitest';
import { computeDrift, renderMarkdown, sameFamily } from '../scripts/detect-model-drift.js';
import type { LiteLLMEntry } from '../scripts/litellm-source.js';
import { MODEL_REGISTRY } from '../src/models.js';
import { isPrefixPassthroughCovered } from '../scripts/propose-parked-models.js';

// Deterministic, no-network: we feed a hand-built LiteLLM catalog and assert the
// diff against the REAL registry behaves. We pick an id that certainly is not in
// the registry as the "new model" and an existing registry model as the control.
// The control must NOT be prefix-passthrough-covered (gpt- / claude- / gemini- /
// o3- / o4-): computeDrift never proposes such ids as parked, so a covered id
// would make every HIGH-signal fixture assertion vacuous.
const existing = MODEL_REGISTRY.find((m) => !isPrefixPassthroughCovered(m.canonical_name))!;

function catalog(entries: Record<string, LiteLLMEntry>): Record<string, LiteLLMEntry> {
  return entries;
}

// A brand-new variant in a family we already route: append "-cendrift9" to an
// existing registry id so sameFamily() matches at a token boundary.
const trackedFamilyNewId = `${existing.api_model_id}-cendrift9`;
const existingLiteLLMProvider = existing.provider === 'google' ? 'gemini' : existing.provider;

describe('computeDrift', () => {
  it('flags a new variant of a family we already route as HIGH-signal', () => {
    const report = computeDrift(
      catalog({
        [trackedFamilyNewId]: {
          litellm_provider: existingLiteLLMProvider,
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
          max_input_tokens: 500000,
        },
      }),
    );
    const found = report.newInTrackedFamily.find((m) => m.model === trackedFamilyNewId);
    expect(found).toBeTruthy();
    expect(found?.kind).toBe('chat');
    expect(found?.context_window).toBe(500000);
  });

  it('puts a model in an UNRELATED family into the long tail, not high-signal', () => {
    const report = computeDrift(
      catalog({
        'zzz-unrelated-family-model-9': {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
        },
      }),
    );
    expect(report.newInTrackedFamily.some((m) => m.model === 'zzz-unrelated-family-model-9')).toBe(false);
    expect(report.newOther.some((m) => m.model === 'zzz-unrelated-family-model-9')).toBe(true);
  });

  it('does NOT flag a model already in the registry', () => {
    const report = computeDrift(
      catalog({
        [existing.api_model_id]: {
          litellm_provider: existingLiteLLMProvider,
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
        },
      }),
    );
    const all = [...report.newInTrackedFamily, ...report.newOther];
    expect(all.some((m) => m.model === existing.api_model_id)).toBe(false);
  });

  it('ignores providers RouteShift does not proxy', () => {
    const report = computeDrift(
      catalog({
        'some-unproxied/thing': {
          litellm_provider: 'replicate',
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
        },
      }),
    );
    expect(report.newInTrackedFamily).toHaveLength(0);
    expect(report.newOther).toHaveLength(0);
  });

  it('ignores non-chat/embedding modes and sample_spec', () => {
    const report = computeDrift(
      catalog({
        sample_spec: { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
        'some-image-model': { litellm_provider: 'openai', mode: 'image_generation', input_cost_per_token: 1e-6 },
      }),
    );
    expect(report.newInTrackedFamily).toHaveLength(0);
    expect(report.newOther).toHaveLength(0);
  });

  it('renders a parked snippet for new chat models in tracked families', () => {
    const md = renderMarkdown(
      computeDrift(
        catalog({
          [trackedFamilyNewId]: {
            litellm_provider: existingLiteLLMProvider,
            mode: 'chat',
            input_cost_per_token: 1e-6,
            output_cost_per_token: 2e-6,
            max_input_tokens: 500000,
          },
        }),
      ),
    );
    expect(md).toContain('auto_route: false');
    expect(md).toContain('public: false');
    expect(md).toContain(trackedFamilyNewId);
  });

  it('sameFamily matches version/variant extensions at a boundary, not substrings', () => {
    expect(sameFamily('glm-5', 'glm-5-code')).toBe(true);
    expect(sameFamily('glm-5', 'glm-5.1')).toBe(true);
    expect(sameFamily('gpt-5.5', 'gpt-5.5-pro')).toBe(true);
    expect(sameFamily('glm-5', 'glm-50')).toBe(false);
    expect(sameFamily('glm-5', 'glm-6')).toBe(false);
  });

  it('keeps prefix-passthrough-covered ids in the report but never in the parked paste block', () => {
    // RSH-166 + review round (codex P2): covered ids must STAY in the report —
    // the workflow's onboarding-issue trigger counts newInTrackedFamily, and
    // covered ids are the ones that need priced manual onboarding. But the
    // parked paste block must never contain them: an exact parked match
    // revokes working prefix-passthrough traffic (pinned proxy-side in
    // tests/proxy-handler-basic.test.ts).
    const report = computeDrift(
      catalog({
        // Family-tracked (sameFamily matches the registered gpt-5.5 /
        // claude-opus-4-8 / gemini-3.5-flash) AND prefix-covered — exactly the
        // population the guard is about.
        'gpt-5.5-cendrift9': {
          litellm_provider: 'openai',
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
        },
        'claude-opus-4-8-cendrift9': {
          litellm_provider: 'anthropic',
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
        },
        'gemini-3.5-flash-cendrift9': {
          litellm_provider: 'gemini',
          mode: 'chat',
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
        },
      }),
    );
    // Surfaced for onboarding (issue trigger fires).
    expect(report.newInTrackedFamily.some((m) => m.model === 'gpt-5.5-cendrift9')).toBe(true);
    expect(report.newInTrackedFamily.some((m) => m.model === 'claude-opus-4-8-cendrift9')).toBe(true);
    expect(report.newInTrackedFamily.some((m) => m.model === 'gemini-3.5-flash-cendrift9')).toBe(true);
    // Never parked: the paste block and the covered-note section are disjoint.
    const markdown = renderMarkdown(report);
    expect(markdown).toContain('prefix-passthrough-covered id(s)');
    const fenced = markdown.match(/```ts\n([\s\S]*?)\n```/);
    const pasteBlock = fenced ? fenced[1] : '';
    expect(pasteBlock).not.toContain('gpt-5.5-cendrift9');
    expect(pasteBlock).not.toContain('claude-opus-4-8-cendrift9');
    expect(pasteBlock).not.toContain('gemini-3.5-flash-cendrift9');
  });

  it('reports no drift for an empty catalog (clean)', () => {
    const report = computeDrift(catalog({}));
    expect(report.newInTrackedFamily).toHaveLength(0);
    expect(report.newOther).toHaveLength(0);
  });
});
