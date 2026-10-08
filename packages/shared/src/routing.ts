import { getModelContextWindow } from './models';
import {
  evaluateRulesWithContextResolver,
  type RequestContext,
  type RoutingDecision,
  type RoutingModelMetadata,
  type RoutingRule,
} from './routing-browser';

export * from './routing-browser';

/**
 * Server evaluator with the curated registry as a fallback for callers that do
 * not inject effective model metadata. Browser code must use routing-browser.
 */
export function evaluateRules(
  rules: RoutingRule[],
  ctx: RequestContext,
  effectiveModels?: readonly RoutingModelMetadata[],
): RoutingDecision {
  return evaluateRulesWithContextResolver(rules, ctx, (canonicalName) => (
    effectiveModels?.find((model) => model.canonical_name === canonicalName)?.context_window
      ?? getModelContextWindow(canonicalName)
  ));
}
