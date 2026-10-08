import { describe, it, expect } from 'vitest';
import { evaluateRules, RouteBlockedError } from '@routeshift/shared';
import type { RoutingRule, RequestContext } from '@routeshift/shared';

describe('evaluateRules', () => {
  const ctx: RequestContext = {
    model_requested: 'gpt-4.1',
    provider_requested: 'openai',
    tags: [],
  };

  it('returns default pass-through when no rules match', () => {
    const decision = evaluateRules([], ctx);
    expect(decision.is_default).toBe(true);
    expect(decision.model).toBe('gpt-4.1');
    expect(decision.provider).toBe('openai');
    expect(decision.max_output_tokens).toBeUndefined();
  });

  it('applies a matching route rule', () => {
    const rules: RoutingRule[] = [{
      id: 'r1', team_id: '*', name: 'Downgrade', priority: 200, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' },
    }];
    const decision = evaluateRules(rules, ctx);
    expect(decision.is_default).toBe(false);
    expect(decision.model).toBe('claude-haiku-4-5');
    expect(decision.provider).toBe('anthropic');
    expect(decision.rule_id).toBe('r1');
  });

  it('evaluates rules in priority order (lower first)', () => {
    const rules: RoutingRule[] = [
      { id: 'low', team_id: '*', name: 'Low', priority: 500, enabled: true,
        condition: { model_requested: 'gpt-4.1' },
        action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-nano' } },
      { id: 'high', team_id: '*', name: 'High', priority: 100, enabled: true,
        condition: { model_requested: 'gpt-4.1' },
        action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' } },
    ];
    const decision = evaluateRules(rules, ctx);
    expect(decision.rule_id).toBe('high');
  });

  it('blocks matching requests', () => {
    const rules: RoutingRule[] = [{
      id: 'block1', team_id: '*', name: 'Block', priority: 10, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: { type: 'block', block_reason: 'Not allowed' },
    }];
    expect(() => evaluateRules(rules, ctx)).toThrow(RouteBlockedError);
    expect(() => evaluateRules(rules, ctx)).toThrow('Not allowed');
  });

  it('tag actions continue evaluation and feed into later rules', () => {
    const rules: RoutingRule[] = [
      { id: 'tag1', team_id: '*', name: 'Tag', priority: 100, enabled: true,
        condition: { model_requested: 'gpt-4.1' },
        action: { type: 'tag', add_tags: ['coding'] } },
      { id: 'route1', team_id: '*', name: 'Route', priority: 200, enabled: true,
        condition: { tags: ['coding'] },
        action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' } },
    ];
    const decision = evaluateRules(rules, ctx);
    expect(decision.tags).toContain('coding');
    expect(decision.rule_id).toBe('route1');
    expect(decision.model).toBe('gpt-4.1-mini');
  });

  it('modify actions are non-terminal and evaluation continues', () => {
    const rules: RoutingRule[] = [
      {
        id: 'modify1', team_id: '*', name: 'Modify placeholder', priority: 100, enabled: true,
        condition: { model_requested: 'gpt-4.1' },
        action: { type: 'modify' },
      },
      {
        id: 'route-after-modify', team_id: '*', name: 'Route after modify', priority: 200, enabled: true,
        condition: { model_requested: 'gpt-4.1' },
        action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' },
      },
    ];

    const decision = evaluateRules(rules, ctx);
    expect(decision.is_default).toBe(false);
    expect(decision.rule_id).toBe('route-after-modify');
    expect(decision.model).toBe('gpt-4.1-mini');
  });

  it('carries max_output_tokens from a modify rule into a later route decision', () => {
    const rules: RoutingRule[] = [
      {
        id: 'cap-output', team_id: '*', name: 'Cap output tokens', priority: 100, enabled: true,
        condition: { model_requested: 'gpt-4.1' },
        action: { type: 'modify', modifications: { max_output_tokens: 500 } },
      },
      {
        id: 'route-after-cap', team_id: '*', name: 'Route after cap', priority: 200, enabled: true,
        condition: { model_requested: 'gpt-4.1' },
        action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' },
      },
    ];

    const decision = evaluateRules(rules, { ...ctx });
    expect(decision.rule_id).toBe('route-after-cap');
    expect(decision.max_output_tokens).toBe(500);
  });

  it('carries max_output_tokens from a modify rule into the default pass-through decision', () => {
    const rules: RoutingRule[] = [{
      id: 'cap-output', team_id: '*', name: 'Cap output tokens', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: { type: 'modify', modifications: { max_output_tokens: 500 } },
    }];

    const decision = evaluateRules(rules, { ...ctx });
    expect(decision.is_default).toBe(true);
    expect(decision.max_output_tokens).toBe(500);
  });

  it('applies model_requested from a modify rule before later conditions run', () => {
    const rules: RoutingRule[] = [
      {
        id: 'modify-model', team_id: '*', name: 'Rewrite model', priority: 100, enabled: true,
        condition: { model_requested: 'gpt-4.1' },
        action: { type: 'modify', modifications: { model_requested: 'gpt-4.1-mini' } },
      },
      {
        id: 'route-rewritten-model', team_id: '*', name: 'Route rewritten model', priority: 200, enabled: true,
        condition: { model_requested: 'gpt-4.1-mini' },
        action: { type: 'route', target_provider: 'openai' },
      },
    ];
    const mutableCtx = { ...ctx };

    const decision = evaluateRules(rules, mutableCtx);
    expect(mutableCtx.model_requested).toBe('gpt-4.1-mini');
    expect(decision.rule_id).toBe('route-rewritten-model');
    expect(decision.model).toBe('gpt-4.1-mini');
  });

  it('skips disabled rules', () => {
    const rules: RoutingRule[] = [{
      id: 'disabled', team_id: '*', name: 'Off', priority: 100, enabled: false,
      condition: { model_requested: 'gpt-4.1' },
      action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' },
    }];
    const decision = evaluateRules(rules, ctx);
    expect(decision.is_default).toBe(true);
  });

  it('matches model arrays (OR logic)', () => {
    const rules: RoutingRule[] = [{
      id: 'arr', team_id: '*', name: 'Array', priority: 200, enabled: true,
      condition: { model_requested: ['gpt-4.1', 'gpt-4o'] },
      action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' },
    }];
    const decision = evaluateRules(rules, ctx);
    expect(decision.model).toBe('claude-haiku-4-5');
  });

  it('falls through to model_pattern when model_requested does not match', () => {
    const rules: RoutingRule[] = [{
      id: 'model-fallback-pattern', team_id: '*', name: 'Pattern fallback', priority: 100, enabled: true,
      condition: { model_requested: ['gpt-3.5', 'claude-2'], model_pattern: 'gpt-4*' },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' },
    }];

    const decision = evaluateRules(rules, ctx);
    expect(decision.is_default).toBe(false);
    expect(decision.model).toBe('gpt-4.1-mini');
  });

  it('does not match when provider_requested condition differs', () => {
    const rules: RoutingRule[] = [{
      id: 'provider-mismatch', team_id: '*', name: 'Provider specific', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1', provider_requested: 'anthropic' },
      action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' },
    }];

    const decision = evaluateRules(rules, ctx);
    expect(decision.is_default).toBe(true);
  });

  it('matches token count conditions', () => {
    const rules: RoutingRule[] = [{
      id: 'tokens', team_id: '*', name: 'Small', priority: 200, enabled: true,
      condition: { max_input_tokens: 500 },
      action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' },
    }];
    // Should match: 300 <= 500
    const small: RequestContext = { ...ctx, estimated_input_tokens: 300 };
    expect(evaluateRules(rules, small).model).toBe('claude-haiku-4-5');
    // Should NOT match: 600 > 500
    const large: RequestContext = { ...ctx, estimated_input_tokens: 600 };
    expect(evaluateRules(rules, large).is_default).toBe(true);
  });

  it('does not match when estimated_input_tokens is below min_input_tokens', () => {
    const rules: RoutingRule[] = [{
      id: 'min-tokens', team_id: '*', name: 'Needs larger prompt', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1', min_input_tokens: 1000 },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' },
    }];

    const tooSmall: RequestContext = { ...ctx, estimated_input_tokens: 50 };
    expect(evaluateRules(rules, tooSmall).is_default).toBe(true);
  });

  it('includes fallback chain from matched rule', () => {
    const rules: RoutingRule[] = [{
      id: 'fb', team_id: '*', name: 'WithFallback', priority: 200, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: {
        type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5',
        fallback_chain: [{ provider: 'openai', model: 'gpt-4.1-mini' }],
      },
    }];
    const decision = evaluateRules(rules, ctx);
    expect(decision.fallback_chain).toEqual([{ provider: 'openai', model: 'gpt-4.1-mini' }]);
  });

  it('time window: same-day window (9-17) uses ctx.current_utc_hour for replayable decisions', () => {
    const rules: RoutingRule[] = [{
      id: 'tw1', team_id: '*', name: 'Business hours', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1', time_window: { start_hour: 9, end_hour: 17 } },
      action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' },
    }];

    const matchResult = evaluateRules(rules, { ...ctx, current_utc_hour: 12 });
    expect(matchResult.is_default).toBe(false);
    expect(matchResult.model).toBe('claude-haiku-4-5');

    const noMatchResult = evaluateRules(rules, { ...ctx, current_utc_hour: 22 });
    expect(noMatchResult.is_default).toBe(true);
  });

  it('time window: overnight window (22-6) matches at 23 and 3, rejects at 12', () => {
    const rules: RoutingRule[] = [{
      id: 'tw2', team_id: '*', name: 'Night shift', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1', time_window: { start_hour: 22, end_hour: 6 } },
      action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' },
    }];

    expect(evaluateRules(rules, { ...ctx, current_utc_hour: 23 }).is_default).toBe(false);
    expect(evaluateRules(rules, { ...ctx, current_utc_hour: 3 }).is_default).toBe(false);
    expect(evaluateRules(rules, { ...ctx, current_utc_hour: 12 }).is_default).toBe(true);
  });

  it('carries reasoning_effort and thinking_budget_tokens from a route rule', () => {
    const rules: RoutingRule[] = [{
      id: 'reasoning', team_id: '*', name: 'Reasoning', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: { type: 'route', target_provider: 'openai', target_model: 'o1-mini', reasoning_effort: 'low', thinking_budget_tokens: 1024 },
    }];

    const decision = evaluateRules(rules, ctx);
    expect(decision.reasoning_effort).toBe('low');
    expect(decision.thinking_budget_tokens).toBe(1024);
  });

  it('carries reasoning_effort and thinking_budget_tokens from a modify rule into default pass-through', () => {
    const rules: RoutingRule[] = [{
      id: 'modify-reasoning', team_id: '*', name: 'Modify reasoning', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: { type: 'modify', modifications: { reasoning_effort: 'high', thinking_budget_tokens: 4096 } },
    }];

    const decision = evaluateRules(rules, { ...ctx });
    expect(decision.is_default).toBe(true);
    expect(decision.reasoning_effort).toBe('high');
    expect(decision.thinking_budget_tokens).toBe(4096);
  });


  it('model_pattern glob matching', () => {
    const rules: RoutingRule[] = [{
      id: 'glob1', team_id: '*', name: 'GPT pattern', priority: 100, enabled: true,
      condition: { model_pattern: 'gpt-4*' },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' },
    }];

    // gpt-4.1 matches gpt-4*
    const matchCtx: RequestContext = { model_requested: 'gpt-4.1', provider_requested: 'openai', tags: [] };
    expect(evaluateRules(rules, matchCtx).is_default).toBe(false);
    expect(evaluateRules(rules, matchCtx).model).toBe('gpt-4.1-mini');

    // gpt-4o matches gpt-4*
    const matchCtx2: RequestContext = { model_requested: 'gpt-4o', provider_requested: 'openai', tags: [] };
    expect(evaluateRules(rules, matchCtx2).is_default).toBe(false);

    // claude-haiku-4-5 does NOT match gpt-4*
    const noMatchCtx: RequestContext = { model_requested: 'claude-haiku-4-5', provider_requested: 'anthropic', tags: [] };
    expect(evaluateRules(rules, noMatchCtx).is_default).toBe(true);

    // Test with ? wildcard
    const rulesQ: RoutingRule[] = [{
      id: 'glob2', team_id: '*', name: 'Single char', priority: 100, enabled: true,
      condition: { model_pattern: 'gpt-4?' },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' },
    }];

    // gpt-4o matches gpt-4? (single char)
    expect(evaluateRules(rulesQ, matchCtx2).is_default).toBe(false);

    // gpt-4.1 does NOT match gpt-4? (too many chars after gpt-4)
    expect(evaluateRules(rulesQ, matchCtx).is_default).toBe(true);
  });

  it('skips route rule when target model context window is too small', () => {
    // Route from claude-opus-4-6 (1M context) to o3 (200K context)
    // with a request that has ~300K estimated tokens
    const rules: RoutingRule[] = [{
      id: 'downroute', team_id: '*', name: 'Downroute to o3', priority: 100, enabled: true,
      condition: { model_requested: 'claude-opus-4-6' },
      action: { type: 'route', target_provider: 'openai', target_model: 'o3' },
    }];

    const largeCtx: RequestContext = {
      model_requested: 'claude-opus-4-6',
      provider_requested: 'anthropic',
      tags: [],
      estimated_input_tokens: 300_000, // exceeds o3's 200K context
    };

    // Should skip the rule and fall through to default (original model)
    const result = evaluateRules(rules, largeCtx);
    expect(result.is_default).toBe(true);
    expect(result.model).toBe('claude-opus-4-6');
  });

  it('applies route rule when target model context window is large enough', () => {
    const rules: RoutingRule[] = [{
      id: 'downroute', team_id: '*', name: 'Downroute to gpt-4.1-mini', priority: 100, enabled: true,
      condition: { model_requested: 'claude-opus-4-6' },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' },
    }];

    const smallCtx: RequestContext = {
      model_requested: 'claude-opus-4-6',
      provider_requested: 'anthropic',
      tags: [],
      estimated_input_tokens: 50_000, // fits in gpt-4.1-mini's 1M context
    };

    const result = evaluateRules(rules, smallCtx);
    expect(result.is_default).toBe(false);
    expect(result.model).toBe('gpt-4.1-mini');
  });

  it('allows route when target model is unknown (no context window data)', () => {
    const rules: RoutingRule[] = [{
      id: 'custom', team_id: '*', name: 'Custom model', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: { type: 'route', target_provider: 'openai', target_model: 'ft:gpt-4.1-custom' },
    }];

    const ctxWithTokens: RequestContext = {
      model_requested: 'gpt-4.1',
      provider_requested: 'openai',
      tags: [],
      estimated_input_tokens: 500_000,
    };

    // Unknown model — no context window data, so allow the route
    const result = evaluateRules(rules, ctxWithTokens);
    expect(result.is_default).toBe(false);
    expect(result.model).toBe('ft:gpt-4.1-custom');
  });

  it('fails closed on a rule with only a custom condition (unsupported by the evaluator)', () => {
    const rules: RoutingRule[] = [{
      id: 'custom-cond', team_id: '*', name: 'Custom condition', priority: 100, enabled: true,
      condition: { custom: { some_future_key: 'value' } },
      action: { type: 'route', target_provider: 'anthropic', target_model: 'claude-haiku-4-5' },
    }];

    // A non-empty `custom` condition must not silently match everything --
    // the rule should be treated as non-matching, not as unconditional.
    const result = evaluateRules(rules, ctx);
    expect(result.is_default).toBe(true);
  });

  it('skips to next rule when first target context is too small', () => {
    const rules: RoutingRule[] = [
      {
        id: 'first', team_id: '*', name: 'Try o3 first', priority: 100, enabled: true,
        condition: { model_requested: 'claude-opus-4-6' },
        action: { type: 'route', target_provider: 'openai', target_model: 'o3' }, // 200K
      },
      {
        id: 'second', team_id: '*', name: 'Fall back to gpt-4.1', priority: 200, enabled: true,
        condition: { model_requested: 'claude-opus-4-6' },
        action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1' }, // 1M
      },
    ];

    const largeCtx: RequestContext = {
      model_requested: 'claude-opus-4-6',
      provider_requested: 'anthropic',
      tags: [],
      estimated_input_tokens: 300_000,
    };

    // Should skip o3 (200K) and use gpt-4.1 (1M)
    const result = evaluateRules(rules, largeCtx);
    expect(result.model).toBe('gpt-4.1');
    expect(result.rule_id).toBe('second');
  });

  it('carries quality_gate from a matched route rule into the decision (inert pass-through)', () => {
    const rules: RoutingRule[] = [{
      id: 'gated', team_id: '*', name: 'Gated', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: {
        type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini',
        quality_gate: {
          version: 1, mode: 'cascade', on_stream: 'reject', unknown_signal: 'reject',
          multi_attempt_billing_ack: true,
          checks: [{ type: 'stop_reason', reject: ['max_tokens'] }],
        },
      },
    }];
    const decision = evaluateRules(rules, ctx);
    expect(decision.rule_id).toBe('gated');
    expect(decision.quality_gate).toEqual({
      version: 1, mode: 'cascade', on_stream: 'reject', unknown_signal: 'reject',
      multi_attempt_billing_ack: true,
      checks: [{ type: 'stop_reason', reject: ['max_tokens'] }],
    });
  });

  it('leaves quality_gate undefined on a route rule that has none', () => {
    const rules: RoutingRule[] = [{
      id: 'ungated', team_id: '*', name: 'Ungated', priority: 100, enabled: true,
      condition: { model_requested: 'gpt-4.1' },
      action: { type: 'route', target_provider: 'openai', target_model: 'gpt-4.1-mini' },
    }];
    const decision = evaluateRules(rules, ctx);
    expect(decision.rule_id).toBe('ungated');
    expect(decision.quality_gate).toBeUndefined();
  });

  it('never synthesizes a quality_gate on the default pass-through decision', () => {
    const decision = evaluateRules([], ctx);
    expect(decision.is_default).toBe(true);
    expect(decision.quality_gate).toBeUndefined();
  });
});
