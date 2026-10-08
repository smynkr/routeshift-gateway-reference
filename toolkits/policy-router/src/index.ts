import { ValidationError, validatePolicy, validateRequest } from './validate.js';
import type {
  Comparison,
  Condition,
  ConditionResult,
  Decision,
  Policy,
  RoutingRequest,
  Target,
  TraceEntry,
} from './types.js';

export { ValidationError, validatePolicy, validateRequest };
export type {
  Action,
  BlockAction,
  Comparison,
  Condition,
  ConditionResult,
  Decision,
  DefaultAction,
  Model,
  Policy,
  RouteAction,
  RoutingRequest,
  Rule,
  Target,
  TagAction,
  TraceEntry,
  TraceStatus,
  UtcWindow,
  ValidationIssue,
} from './types.js';

interface MatchedConditions {
  passed: boolean;
  results: ConditionResult[];
  failedFields: string[];
}

interface TerminalResult {
  outcome: 'route' | 'block';
  target?: Target;
  ruleId: string | null;
  reason: string;
}

function advanceCodePoint(value: string, offset: number): number {
  const codePoint = value.codePointAt(offset);
  return offset + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

/** Full-string glob matching for only '*' and '?'; all other code points are literal. */
function matchesGlob(pattern: string, value: string): boolean {
  let patternOffset = 0;
  let valueOffset = 0;
  let lastStarEnd = -1;
  let lastStarValueOffset = -1;

  while (valueOffset < value.length) {
    if (patternOffset < pattern.length && pattern[patternOffset] === '?') {
      patternOffset += 1;
      valueOffset = advanceCodePoint(value, valueOffset);
      continue;
    }
    if (patternOffset < pattern.length && pattern[patternOffset] === '*') {
      while (patternOffset < pattern.length && pattern[patternOffset] === '*') patternOffset += 1;
      lastStarEnd = patternOffset;
      lastStarValueOffset = valueOffset;
      continue;
    }

    const patternCodePoint = pattern.codePointAt(patternOffset);
    const valueCodePoint = value.codePointAt(valueOffset);
    if (patternCodePoint !== undefined && patternCodePoint === valueCodePoint) {
      patternOffset = advanceCodePoint(pattern, patternOffset);
      valueOffset = advanceCodePoint(value, valueOffset);
      continue;
    }

    if (lastStarEnd >= 0 && lastStarValueOffset < value.length) {
      lastStarValueOffset = advanceCodePoint(value, lastStarValueOffset);
      valueOffset = lastStarValueOffset;
      patternOffset = lastStarEnd;
      continue;
    }
    return false;
  }

  while (patternOffset < pattern.length && pattern[patternOffset] === '*') patternOffset += 1;
  return patternOffset === pattern.length;
}

function matchConditions(condition: Condition, request: RoutingRequest, tags: readonly string[]): MatchedConditions {
  const results: ConditionResult[] = [];
  const failedFields: string[] = [];
  let passed = true;
  let modelPassed = true;
  let exactModelPassed: boolean | undefined;
  let patternModelPassed: boolean | undefined;

  if (condition.models !== undefined) {
    exactModelPassed = condition.models.includes(request.model);
    results.push({
      field: 'models',
      passed: exactModelPassed,
      expected: [...condition.models],
      actual: request.model,
    });
    modelPassed = exactModelPassed;
  }
  if (condition.modelPattern !== undefined) {
    patternModelPassed = matchesGlob(condition.modelPattern, request.model);
    results.push({
      field: 'modelPattern',
      passed: patternModelPassed,
      expected: condition.modelPattern,
      actual: request.model,
    });
    modelPassed = exactModelPassed === undefined ? patternModelPassed : exactModelPassed || patternModelPassed;
  }
  if (!modelPassed) {
    passed = false;
    failedFields.push('model');
  }

  if (condition.providers !== undefined) {
    const providerPassed = condition.providers.includes(request.provider);
    results.push({
      field: 'providers',
      passed: providerPassed,
      expected: [...condition.providers],
      actual: request.provider,
    });
    if (!providerPassed) {
      passed = false;
      failedFields.push('providers');
    }
  }

  if (condition.allTags !== undefined) {
    const tagsPassed = condition.allTags.every((tag) => tags.includes(tag));
    results.push({
      field: 'allTags',
      passed: tagsPassed,
      expected: [...condition.allTags],
      actual: [...tags],
    });
    if (!tagsPassed) {
      passed = false;
      failedFields.push('allTags');
    }
  }

  if (condition.minInputTokens !== undefined) {
    const minimumPassed = request.inputTokens >= condition.minInputTokens;
    results.push({
      field: 'minInputTokens',
      passed: minimumPassed,
      expected: condition.minInputTokens,
      actual: request.inputTokens,
    });
    if (!minimumPassed) {
      passed = false;
      failedFields.push('minInputTokens');
    }
  }

  if (condition.maxInputTokens !== undefined) {
    const maximumPassed = request.inputTokens <= condition.maxInputTokens;
    results.push({
      field: 'maxInputTokens',
      passed: maximumPassed,
      expected: condition.maxInputTokens,
      actual: request.inputTokens,
    });
    if (!maximumPassed) {
      passed = false;
      failedFields.push('maxInputTokens');
    }
  }

  if (condition.utcWindow !== undefined) {
    // Evaluation is reached only after the required captured hour has been validated.
    const hour = request.utcHour as number;
    const { start, end } = condition.utcWindow;
    const windowPassed = start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
    results.push({
      field: 'utcWindow',
      passed: windowPassed,
      expected: { start, end },
      actual: hour,
    });
    if (!windowPassed) {
      passed = false;
      failedFields.push('utcWindow');
    }
  }

  return { passed, results, failedFields };
}

function assertRequiredUtcHour(policy: Policy, request: RoutingRequest): void {
  if (request.utcHour !== undefined) return;
  const issues = policy.rules.flatMap((rule, index) => (
    rule.enabled !== false && rule.when.utcWindow !== undefined
      ? [{
        path: '$.utcHour',
        code: 'required_for_policy',
        message: `Enabled time-window rule "${rule.id}" requires request.utcHour.`,
      }]
      : []
  ));
  if (issues.length > 0) throw new ValidationError(issues);
}

function makeDecision(
  policy: Policy,
  outcome: 'route' | 'block',
  ruleId: string | null,
  reason: string,
  tags: readonly string[],
  trace: TraceEntry[],
  target?: Target,
): Decision {
  const decision: Decision = {
    policy: { id: policy.id, revision: policy.revision },
    outcome,
    ruleId,
    reason,
    tags: [...tags],
    trace,
  };
  if (target !== undefined) decision.target = { provider: target.provider, model: target.model };
  return decision;
}

function evaluateValidated(policy: Policy, request: RoutingRequest): Decision {
  const tags = [...(request.tags ?? [])];
  const tagSet = new Set(tags);
  const trace: TraceEntry[] = [];
  const order = policy.rules.map((_rule, index) => index);
  order.sort((left, right) => (
    policy.rules[left].priority - policy.rules[right].priority || left - right
  ));

  let terminal: TerminalResult | undefined;
  for (const index of order) {
    const rule = policy.rules[index];
    if (terminal !== undefined) {
      trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        status: 'not_evaluated',
        reason: 'not_evaluated_after_terminal_rule',
        conditions: [],
      });
      continue;
    }
    if (rule.enabled === false) {
      trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        status: 'disabled',
        reason: 'rule_disabled',
        conditions: [],
      });
      continue;
    }

    const matched = matchConditions(rule.when, request, tags);
    if (!matched.passed) {
      trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        status: 'unmatched',
        reason: `conditions_not_met:${matched.failedFields.join(',')}`,
        conditions: matched.results,
      });
      continue;
    }

    if (rule.then.type === 'tag') {
      const addedTags: string[] = [];
      for (const tag of rule.then.tags) {
        if (!tagSet.has(tag)) {
          tagSet.add(tag);
          tags.push(tag);
          addedTags.push(tag);
        }
      }
      trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        status: 'tagged',
        reason: addedTags.length > 0 ? 'tags_added' : 'no_new_tags',
        conditions: matched.results,
        addedTags,
      });
      continue;
    }

    if (rule.then.type === 'block') {
      trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        status: 'blocked',
        reason: rule.then.reason,
        conditions: matched.results,
      });
      terminal = { outcome: 'block', ruleId: rule.id, reason: rule.then.reason };
      continue;
    }

    const routeTarget = rule.then.target;
    const catalogModel = policy.catalog.find((item) => (
      item.provider === routeTarget.provider && item.model === routeTarget.model
    ));
    // Full policy validation guarantees a catalog entry for every route target.
    const contextWindow = catalogModel?.contextWindow as number;
    const totalTokens = request.inputTokens + request.outputTokens;
    const capacityPassed = totalTokens <= contextWindow;
    const conditions = [
      ...matched.results,
      {
        field: 'contextWindow',
        passed: capacityPassed,
        expected: contextWindow,
        actual: totalTokens,
      },
    ];
    if (!capacityPassed) {
      trace.push({
        ruleId: rule.id,
        priority: rule.priority,
        status: 'capacity_exceeded',
        reason: 'context_capacity_exceeded',
        conditions,
        target: { provider: routeTarget.provider, model: routeTarget.model },
      });
      continue;
    }

    const target = { provider: routeTarget.provider, model: routeTarget.model };
    trace.push({
      ruleId: rule.id,
      priority: rule.priority,
      status: 'selected',
      reason: 'rule_selected',
      conditions,
      target: { provider: target.provider, model: target.model },
    });
    terminal = { outcome: 'route', target, ruleId: rule.id, reason: 'rule_selected' };
  }

  if (terminal !== undefined) {
    return makeDecision(policy, terminal.outcome, terminal.ruleId, terminal.reason, tags, trace, terminal.target);
  }

  if (policy.defaultAction.type === 'block') {
    return makeDecision(policy, 'block', null, policy.defaultAction.reason, tags, trace);
  }

  const defaultTarget = policy.defaultAction.target;
  const defaultCatalogModel = policy.catalog.find((item) => (
    item.provider === defaultTarget.provider && item.model === defaultTarget.model
  ));
  const defaultContextWindow = defaultCatalogModel?.contextWindow as number;
  const totalTokens = request.inputTokens + request.outputTokens;
  if (totalTokens > defaultContextWindow) {
    return makeDecision(policy, 'block', null, 'context_capacity_exceeded', tags, trace);
  }
  return makeDecision(policy, 'route', null, 'default_selected', tags, trace, defaultTarget);
}

/** Validate and deterministically evaluate an immutable policy/request snapshot. */
export function evaluate(policyValue: unknown, requestValue: unknown): Decision {
  const policy = validatePolicy(policyValue);
  const request = validateRequest(requestValue);
  assertRequiredUtcHour(policy, request);
  return evaluateValidated(policy, request);
}

/** Compare selected decisions while retaining both full traces for explanation. */
export function comparePolicies(beforeValue: unknown, afterValue: unknown, requestValue: unknown): Comparison {
  const beforePolicy = validatePolicy(beforeValue);
  const afterPolicy = validatePolicy(afterValue);
  const request = validateRequest(requestValue);
  assertRequiredUtcHour(beforePolicy, request);
  assertRequiredUtcHour(afterPolicy, request);

  const before = evaluateValidated(beforePolicy, request);
  const after = evaluateValidated(afterPolicy, request);
  let tagsEqual = before.tags.length === after.tags.length;
  for (let index = 0; tagsEqual && index < before.tags.length; index += 1) {
    tagsEqual = before.tags[index] === after.tags[index];
  }
  const beforeTarget = before.target;
  const afterTarget = after.target;
  const targetsEqual = beforeTarget === undefined
    ? afterTarget === undefined
    : afterTarget !== undefined
      && beforeTarget.provider === afterTarget.provider
      && beforeTarget.model === afterTarget.model;

  return {
    changed: before.outcome !== after.outcome
      || !targetsEqual
      || before.ruleId !== after.ruleId
      || before.reason !== after.reason
      || !tagsEqual,
    before,
    after,
  };
}
