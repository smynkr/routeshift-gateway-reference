import type { RequestContext, RoutingDecision, RoutingRule } from '@routeshift/shared/routing-browser';
import { requireCurrentModel } from './current-models';

const CURRENT = {
  coding: requireCurrentModel('coding'),
  economy: requireCurrentModel('economy'),
} as const;
export const DEMO_PLAYGROUND_RULES = [
  {
    id: 'demo-coding-route',
    team_id: 'demo',
    name: 'Coding requests use a fast coding model',
    priority: 10,
    enabled: true,
    condition: { tags: ['coding'] },
    action: {
      type: 'route',
      target_provider: CURRENT.coding.provider,
      target_model: CURRENT.coding.canonical_name,
      fallback_chain: [{ provider: CURRENT.economy.provider, model: CURRENT.economy.canonical_name }],
    },
  },
] as const satisfies readonly RoutingRule[];

export function playgroundContext(input: {
  model: string;
  provider: string;
  prompt: string;
  estimatedInputTokens: number;
}): RequestContext {
  const tags = /\b(code|coding|function|typescript|javascript|python)\b/i.test(input.prompt)
    ? ['coding']
    : [];

  return {
    model_requested: input.model,
    provider_requested: input.provider || 'openai',
    tags,
    estimated_input_tokens: Number.isFinite(input.estimatedInputTokens)
      ? Math.max(0, input.estimatedInputTokens)
      : 0,
  };
}

export function explainPlaygroundDecision(decision: RoutingDecision, context?: RequestContext): string {
  if (decision.rule_id) {
    const fallback = decision.fallback_chain.length > 0
      ? ` Fallback: ${decision.fallback_chain.map((route) => `${route.provider}/${route.model}`).join(', ')}.`
      : '';
    return `Matched demo rule ${decision.rule_id}; route to ${decision.provider}/${decision.model}.${fallback}`;
  }

  const codingRule = DEMO_PLAYGROUND_RULES.find((rule) => rule.id === 'demo-coding-route');
  const targetModel = codingRule?.action.type === 'route' ? codingRule.action.target_model : undefined;
  const targetContextWindow = targetModel === CURRENT.coding.canonical_name ? CURRENT.coding.context_window : null;
  const estimatedInputTokens = context?.estimated_input_tokens ?? 0;
  if (
    context?.tags.includes('coding')
    && targetContextWindow !== null
    && estimatedInputTokens > targetContextWindow
  ) {
    return `The demo route was skipped because ${targetModel} has a ${targetContextWindow.toLocaleString()}-token context window and this request is estimated at ${estimatedInputTokens.toLocaleString()} tokens; it remains on ${decision.provider}/${decision.model}.`;
  }

  return `No demo rule matched these derived tags, so this request remains on ${decision.provider}/${decision.model}.`;
}
