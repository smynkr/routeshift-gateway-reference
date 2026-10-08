// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EFFECTIVE_PUBLIC_MODELS, evaluateRules } from '@routeshift/shared';
import { CURRENT_MODEL_FIXTURE } from '@routeshift/shared/current-models.generated';
import {
  CURRENT_MODELS,
  requireCurrentModel,
} from '@/lib/current-models';
import {
  DEMO_PLAYGROUND_RULES,
  explainPlaygroundDecision,
  playgroundContext,
} from '@/lib/routing-playground';
import { RouteDecisionTrace } from '@/components/marketing/route-decision-trace';

afterEach(() => cleanup());

describe('routing decision trace', () => {
  it('derives coding from a code prompt and selects the fixed demo route', () => {
    const context = playgroundContext({
      model: CURRENT_MODELS.default,
      provider: requireCurrentModel('default').provider,
      prompt: 'Review this TypeScript code for a bug.',
      estimatedInputTokens: 1_000,
    });
    const decision = evaluateRules([...DEMO_PLAYGROUND_RULES], context, [requireCurrentModel('coding')]);

    expect(context.tags).toContain('coding');
    expect(decision).toMatchObject({ provider: requireCurrentModel('coding').provider, model: CURRENT_MODELS.coding });
    expect(explainPlaygroundDecision(decision)).toMatch(/matched/i);
  });
  it('keeps the demo target model in the effective generated role catalog', () => {
    const target = DEMO_PLAYGROUND_RULES[0]?.action.target_model;
    const expected = CURRENT_MODEL_FIXTURE.coding;
    expect(target).toBe(expected.canonical_name);
    expect(EFFECTIVE_PUBLIC_MODELS).toContainEqual(expect.objectContaining(expected));
  });

  it('explains that an oversized prompt cannot use the smaller target context window', () => {
    const targetModel = requireCurrentModel('coding');
    const context = playgroundContext({
      model: CURRENT_MODELS.economy,
      provider: requireCurrentModel('economy').provider,
      prompt: 'Write code for this system.',
      estimatedInputTokens: targetModel.context_window + 1,
    });
    const decision = evaluateRules([...DEMO_PLAYGROUND_RULES], context, [requireCurrentModel('coding')]);

    expect(decision.is_default).toBe(true);
    expect(explainPlaygroundDecision(decision, context)).toMatch(/context window/i);
  });

  it('switches between matched and default route examples without network traffic', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<RouteDecisionTrace />);
    expect(screen.getByRole('group', { name: 'Route examples' })).toBeDefined();

    const coding = requireCurrentModel('coding');
    expect(screen.getByText('demo-coding-route')).toBeDefined();
    expect(screen.getByText(`${coding.provider}/${coding.canonical_name}`)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'General Q&A' }));
    const general = requireCurrentModel('default');
    expect(screen.getByText('default')).toBeDefined();
    expect(screen.getByText(`${general.provider}/${general.canonical_name}`)).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders an explicit blocked state when the injected evaluator throws', () => {
    const throwingEvaluator = vi.fn(() => {
      throw new Error('policy blocked');
    });
    render(<RouteDecisionTrace ruleEvaluator={throwingEvaluator as typeof evaluateRules} />);

    expect(screen.getAllByText('Blocked: policy blocked').length).toBeGreaterThan(0);
    expect(screen.getByText('Blocked: policy blocked', { selector: 'dd' })).toBeDefined();
  });

  it('uses the trace-specific copy failure label and AA route marker', async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<RouteDecisionTrace />);

    expect(screen.getByText('03').className).toContain('text-zinc-400');
    fireEvent.click(screen.getByRole('button', { name: 'Copy explanation' }));
    expect(await screen.findByRole('button', { name: 'Copy failed — select the explanation' })).toBeDefined();
  });
});
