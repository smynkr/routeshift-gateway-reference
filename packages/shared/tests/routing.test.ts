import { describe, expect, it } from 'vitest';
import { evaluateRules, RouteBlockedError } from '../src/routing';
import type { RequestContext, RoutingRule } from '../src/routing';
import { evaluateRulesPure } from '../src/routing-browser';

describe('shared routing evaluator', () => {
  const baseContext: RequestContext = {
    model_requested: 'gpt-5.4',
    provider_requested: 'openai',
    tags: [],
    estimated_input_tokens: 10,
    current_utc_hour: 12,
  };

  it('keeps a route after tag and modify actions', () => {
    const result = evaluateRules([
      {
        id: 'tag', team_id: 'demo', name: 'tag', priority: 1, enabled: true,
        condition: {}, action: { type: 'tag', add_tags: ['coding'] },
      },
      {
        id: 'modify', team_id: 'demo', name: 'modify', priority: 2, enabled: true,
        condition: { tags: ['coding'] }, action: { type: 'modify', modifications: { model_requested: 'gpt-5.4-mini' } },
      },
      {
        id: 'route', team_id: 'demo', name: 'route', priority: 3, enabled: true,
        condition: { model_requested: 'gpt-5.4-mini' },
        action: { type: 'route', target_provider: 'openai', target_model: 'gpt-5.4-mini' },
      },
    ], { ...baseContext });

    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      rule_id: 'route',
      tags: ['coding'],
    });
  });

  it('skips a route whose target context window is too small', () => {
    const rules: RoutingRule[] = [
      {
        id: 'too-small', team_id: 'demo', name: 'too-small', priority: 1, enabled: true,
        condition: {}, action: { type: 'route', target_provider: 'openai', target_model: 'o3' },
      },
    ];

    const result = evaluateRules(rules, {
      ...baseContext,
      model_requested: 'claude-opus-4-6',
      estimated_input_tokens: 300_000,
    });

    expect(result).toMatchObject({ is_default: true, provider: 'openai', model: 'claude-opus-4-6' });
  });
  it('uses effective catalog metadata for generated target context checks', () => {
    const target = {
      provider: 'openai' as const,
      canonical_name: 'generated-small-context',
      api_model_id: 'generated-small-context',
      context_window: 128,
    };
    const result = evaluateRules([
      {
        id: 'generated-too-small', team_id: 'demo', name: 'generated-too-small', priority: 1, enabled: true,
        condition: {}, action: { type: 'route', target_provider: target.provider, target_model: target.canonical_name },
      },
    ], {
      ...baseContext,
      model_requested: 'generated-source',
      estimated_input_tokens: 129,
    }, [target]);

    expect(result).toMatchObject({ is_default: true, model: 'generated-source' });
  });

  it('uses only injected context metadata in the browser-safe evaluator', () => {
    const rules: RoutingRule[] = [{
      id: 'browser-context',
      team_id: 'demo',
      name: 'browser-context',
      priority: 1,
      enabled: true,
      condition: {},
      action: { type: 'route', target_provider: 'openai', target_model: 'o3' },
    }];
    const context = {
      ...baseContext,
      model_requested: 'source-model',
      estimated_input_tokens: 300_000,
    };

    expect(evaluateRulesPure(rules, { ...context }, [{
      canonical_name: 'o3',
      context_window: 200_000,
    }])).toMatchObject({ is_default: true, model: 'source-model' });
    expect(evaluateRulesPure(rules, { ...context }, [])).toMatchObject({
      is_default: false,
      model: 'o3',
    });
  });

  it('preserves fallback chains from the terminal route', () => {
    const result = evaluateRules([
      {
        id: 'fallback', team_id: 'demo', name: 'fallback', priority: 1, enabled: true,
        condition: {},
        action: {
          type: 'route', target_provider: 'anthropic', target_model: 'claude-sonnet-4-6',
          fallback_chain: [{ provider: 'openai', model: 'gpt-5.4-mini' }],
        },
      },
    ], baseContext);

    expect(result.fallback_chain).toEqual([{ provider: 'openai', model: 'gpt-5.4-mini' }]);
  });

  it('throws the exact rule id when a rule blocks', () => {
    expect(() => evaluateRules([
      {
        id: 'blocked-rule', team_id: 'demo', name: 'blocked', priority: 1, enabled: true,
        condition: {}, action: { type: 'block', block_reason: 'policy blocked' },
      },
    ], baseContext)).toThrowError(RouteBlockedError);

    try {
      evaluateRules([
        {
          id: 'blocked-rule', team_id: 'demo', name: 'blocked', priority: 1, enabled: true,
          condition: {}, action: { type: 'block', block_reason: 'policy blocked' },
        },
      ], baseContext);
    } catch (error) {
      expect(error).toMatchObject({ ruleId: 'blocked-rule', message: 'policy blocked' });
    }
  });
});
