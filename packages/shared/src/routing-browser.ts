import type { CapabilityAxis } from './capability-sources';
import type { QualityGateConfig } from './response-verifier';

export interface RoutingRule {
  id: string;
  team_id: string;
  name: string;
  priority: number;
  enabled: boolean;
  condition: RuleCondition;
  action: RoutingAction;
}

export interface RuleCondition {
  model_requested?: string | string[];
  model_pattern?: string;
  provider_requested?: string;
  tags?: string[];
  max_input_tokens?: number;
  min_input_tokens?: number;
  time_window?: { start_hour: number; end_hour: number };
  custom?: Record<string, unknown>;
}

export interface RoutingAction {
  type: 'route' | 'block' | 'tag' | 'modify';
  target_provider?: string;
  target_model?: string;
  block_reason?: string;
  add_tags?: string[];
  modifications?: Record<string, unknown>;
  fallback_chain?: Array<{ provider: string; model: string }>;
  reasoning_effort?: 'low' | 'medium' | 'high';
  thinking_budget_tokens?: number;
  quality_gate?: QualityGateConfig;
}

export interface RoutingDecision {
  provider: string;
  model: string;
  rule_id: string | null;
  tags: string[];
  fallback_chain: Array<{ provider: string; model: string }>;
  is_default: boolean;
  max_output_tokens?: number;
  auto_route?: AutoRouteMetadata;
  reasoning_effort?: 'low' | 'medium' | 'high';
  thinking_budget_tokens?: number;
  quality_gate?: QualityGateConfig;
}

export interface RoutingModelMetadata {
  canonical_name: string;
  context_window: number;
}

export interface RequestContext {
  model_requested: string;
  provider_requested: string;
  tags: string[];
  max_output_tokens?: number;
  estimated_input_tokens?: number;
  /** UTC hour captured at request ingress so rule evaluation is replayable. */
  current_utc_hour?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
  thinking_budget_tokens?: number;
  has_tools?: boolean;
  has_structured_output?: boolean;
  has_code_blocks?: boolean;
}

export interface AutoRouteProviderSkip {
  provider: string;
  reason: string;
}

export interface AutoRouteMetadata {
  provider_skips: AutoRouteProviderSkip[];
  latency_mode?: 'not_applicable' | 'latency_measured' | 'latency_measured_partial' | 'throughput_heuristic';
  capability_axis?: CapabilityAxis;
  quality_derank?: Array<{
    provider: string;
    model: string;
    pass_rate: number;
    sample_count: number;
  }>;
}

export class RouteBlockedError extends Error {
  public readonly ruleId: string;

  constructor(message: string, ruleId: string) {
    super(message);
    this.name = 'RouteBlockedError';
    this.ruleId = ruleId;
  }
}

type ContextWindowResolver = (canonicalName: string) => number | null | undefined;

/**
 * Browser-safe evaluator. Target context metadata is supplied by the caller;
 * unknown targets stay eligible rather than pulling the server catalog into
 * the browser bundle.
 */
export function evaluateRulesPure(
  rules: RoutingRule[],
  ctx: RequestContext,
  effectiveModels: readonly RoutingModelMetadata[],
): RoutingDecision {
  return evaluateRulesWithContextResolver(
    rules,
    ctx,
    (canonicalName) => effectiveModels.find(
      (model) => model.canonical_name === canonicalName,
    )?.context_window,
  );
}

/** Server adapter seam; browser callers should prefer evaluateRulesPure. */
export function evaluateRulesWithContextResolver(
  rules: RoutingRule[],
  ctx: RequestContext,
  resolveContextWindow: ContextWindowResolver,
): RoutingDecision {
  const sorted = rules.filter((rule) => rule.enabled).slice().sort((a, b) => a.priority - b.priority);
  const tags = [...ctx.tags];

  for (const rule of sorted) {
    if (!matchCondition(rule.condition, ctx, tags)) continue;

    switch (rule.action.type) {
      case 'block':
        throw new RouteBlockedError(
          rule.action.block_reason ?? 'Request blocked by routing rule',
          rule.id,
        );

      case 'tag':
        if (rule.action.add_tags) tags.push(...rule.action.add_tags);
        break;

      case 'modify':
        applyModifications(rule.action.modifications, ctx, tags);
        break;

      case 'route': {
        const targetModel = rule.action.target_model ?? ctx.model_requested;
        if (targetModel !== ctx.model_requested && ctx.estimated_input_tokens) {
          const targetContext = resolveContextWindow(targetModel);
          if (targetContext != null && ctx.estimated_input_tokens > targetContext) {
            continue;
          }
        }

        return {
          provider: rule.action.target_provider ?? ctx.provider_requested,
          model: targetModel,
          rule_id: rule.id,
          tags,
          fallback_chain: rule.action.fallback_chain ?? [],
          is_default: false,
          max_output_tokens: ctx.max_output_tokens,
          reasoning_effort: rule.action.reasoning_effort ?? ctx.reasoning_effort,
          thinking_budget_tokens: rule.action.thinking_budget_tokens ?? ctx.thinking_budget_tokens,
          quality_gate: rule.action.quality_gate,
        };
      }
    }
  }

  return {
    provider: ctx.provider_requested,
    model: ctx.model_requested,
    rule_id: null,
    tags,
    fallback_chain: [],
    is_default: true,
    max_output_tokens: ctx.max_output_tokens,
    reasoning_effort: ctx.reasoning_effort,
    thinking_budget_tokens: ctx.thinking_budget_tokens,
  };
}

function applyModifications(
  mods: Record<string, unknown> | undefined,
  ctx: RequestContext,
  tags: string[],
): void {
  if (!mods) return;

  if (typeof mods.model_requested === 'string' && mods.model_requested.length > 0) {
    ctx.model_requested = mods.model_requested;
  }
  if (typeof mods.provider_requested === 'string' && mods.provider_requested.length > 0) {
    ctx.provider_requested = mods.provider_requested;
  }
  if (Array.isArray(mods.add_tags)) {
    tags.push(...mods.add_tags.filter((tag): tag is string => typeof tag === 'string'));
  }
  if (
    typeof mods.max_output_tokens === 'number'
    && Number.isFinite(mods.max_output_tokens)
    && mods.max_output_tokens > 0
  ) {
    ctx.max_output_tokens = mods.max_output_tokens;
  }
  if (
    typeof mods.reasoning_effort === 'string'
    && ['low', 'medium', 'high'].includes(mods.reasoning_effort)
  ) {
    ctx.reasoning_effort = mods.reasoning_effort as 'low' | 'medium' | 'high';
  }
  if (
    typeof mods.thinking_budget_tokens === 'number'
    && Number.isFinite(mods.thinking_budget_tokens)
    && mods.thinking_budget_tokens > 0
  ) {
    ctx.thinking_budget_tokens = mods.thinking_budget_tokens;
  }
}

function matchCondition(cond: RuleCondition, ctx: RequestContext, currentTags: string[]): boolean {
  if (cond.model_requested !== undefined) {
    const models = Array.isArray(cond.model_requested) ? cond.model_requested : [cond.model_requested];
    if (!models.includes(ctx.model_requested)) {
      if (!cond.model_pattern || !matchGlob(cond.model_pattern, ctx.model_requested)) return false;
    }
  } else if (cond.model_pattern !== undefined && !matchGlob(cond.model_pattern, ctx.model_requested)) {
    return false;
  }

  if (cond.provider_requested !== undefined && cond.provider_requested !== ctx.provider_requested) {
    return false;
  }
  if (cond.tags && cond.tags.length > 0 && !cond.tags.every((tag) => currentTags.includes(tag))) {
    return false;
  }
  if (
    cond.max_input_tokens !== undefined
    && ctx.estimated_input_tokens !== undefined
    && ctx.estimated_input_tokens > cond.max_input_tokens
  ) {
    return false;
  }
  if (
    cond.min_input_tokens !== undefined
    && ctx.estimated_input_tokens !== undefined
    && ctx.estimated_input_tokens < cond.min_input_tokens
  ) {
    return false;
  }

  if (cond.time_window) {
    const hour = ctx.current_utc_hour;
    if (hour === undefined) return false;
    const { start_hour, end_hour } = cond.time_window;
    if (start_hour <= end_hour) {
      if (hour < start_hour || hour >= end_hour) return false;
    } else if (hour < start_hour && hour >= end_hour) {
      return false;
    }
  }

  if (cond.custom && Object.keys(cond.custom).length > 0) return false;
  return true;
}

const regexCache = new Map<string, RegExp>();

function matchGlob(pattern: string, value: string): boolean {
  let regex = regexCache.get(pattern);
  if (!regex) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexSource = `^${escaped.replace(/\*/g, '.*?').replace(/\?/g, '.')}$`;
    regex = new RegExp(regexSource);
    if (regexCache.size < 1_000) regexCache.set(pattern, regex);
  }
  return regex.test(value);
}
