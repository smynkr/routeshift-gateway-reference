import { qualityGateConfigToDraft } from '@/components/routing/quality-gate-editor';
import { PROVIDERS } from '@routeshift/shared';

/**
 * A stored routing rule is editable only when the rule form can round-trip it
 * WITHOUT silently dropping or inventing fields: the editor rebuilds
 * condition/action objects from a fixed set of inputs, so any stored key the
 * editor does not manage would be lost on save (or, for a route rule without
 * target_provider, replaced by a default that changes routing semantics).
 *
 * Returns a human-readable list of gaps; empty = editable. The edit page
 * refuses loudly when non-empty (fail loud, never lossy round-trip).
 */
export function describeRuleEditorGaps(rule: {
  condition?: unknown;
  action?: unknown;
}): string[] {
  const gaps: string[] = [];
  const condition = (rule.condition ?? {}) as Record<string, unknown>;
  const action = (rule.action ?? {}) as Record<string, unknown>;

  const CONDITION_KEYS: Record<string, true> = {
    model_requested: true,
    tags: true,
    max_input_tokens: true,
  };
  for (const key of Object.keys(condition)) {
    if (!CONDITION_KEYS[key]) {
      gaps.push(`condition.${key} is not supported by the rule editor`);
    }
  }
  // Value shapes the editor cannot round-trip: the form joins arrays into a
  // comma string and emits a single string, so a stored ARRAY matcher would be
  // permanently collapsed to a different (string) shape on save.
  if (Array.isArray(condition.model_requested)) {
    gaps.push('condition.model_requested arrays cannot be edited (the editor emits a single string)');
  }
  if (
    condition.tags !== undefined &&
    (!Array.isArray(condition.tags) || !condition.tags.every((t) => typeof t === 'string'))
  ) {
    gaps.push('condition.tags must be an array of strings');
  }
  if (condition.max_input_tokens !== undefined && typeof condition.max_input_tokens !== 'number') {
    gaps.push('condition.max_input_tokens must be a number');
  }

  const actionType = action.type;
  if (actionType !== 'route' && actionType !== 'block' && actionType !== 'tag') {
    gaps.push(`action.type '${String(actionType)}' is not supported by the rule editor`);
    // Remaining checks assume a supported type; stop early.
    return gaps;
  }

  const ALLOWED_ACTION_KEYS: Record<string, Record<string, true>> = {
    route: { type: true, target_provider: true, target_model: true, fallback_chain: true, quality_gate: true },
    block: { type: true, block_reason: true },
    tag: { type: true, add_tags: true },
  };
  const allowed = ALLOWED_ACTION_KEYS[actionType];
  for (const key of Object.keys(action)) {
    if (!allowed[key]) {
      gaps.push(`action.${key} is not supported by the rule editor`);
    }
  }
  if (actionType === 'block' && action.block_reason !== undefined && typeof action.block_reason !== 'string') {
    gaps.push('action.block_reason must be a string');
  }
  if (
    actionType === 'tag' &&
    action.add_tags !== undefined &&
    (!Array.isArray(action.add_tags) || !action.add_tags.every((t) => typeof t === 'string'))
  ) {
    gaps.push('action.add_tags must be an array of strings');
  }

  if (actionType === 'route') {
    // A route without target_provider routes to the REQUESTED provider
    // (evaluator: target_provider ?? ctx.provider_requested). The editor
    // always sends target_provider (defaults to openai), so an absent one
    // cannot round-trip without changing behavior — and a present provider
    // outside PROVIDERS would be silently replaced by the openai default.
    if (typeof action.target_provider !== 'string') {
      gaps.push('route actions without a target provider cannot be edited');
    } else if (!(PROVIDERS as readonly string[]).includes(action.target_provider)) {
      gaps.push(`action.target_provider '${action.target_provider}' is not a supported provider`);
    }
    if (
      action.fallback_chain !== undefined &&
      (!Array.isArray(action.fallback_chain) ||
        !action.fallback_chain.every(
          (f) =>
            f && typeof f === 'object' &&
            typeof (f as { provider?: unknown }).provider === 'string' &&
            (PROVIDERS as readonly string[]).includes((f as { provider: string }).provider) &&
            typeof (f as { model?: unknown }).model === 'string' &&
            // Extra keys are stripped by the editor's rebuild — a lossy
            // round-trip must refuse, not silently drop.
            Object.keys(f).every((key) => key === 'provider' || key === 'model'),
        ))
    ) {
      gaps.push('action.fallback_chain entries must be { provider, model } with a supported provider');
    }
    const gate = action.quality_gate;
    if (gate !== undefined && qualityGateConfigToDraft(gate) === null) {
      gaps.push('the stored quality gate uses features the editor cannot represent');
    }
  }

  return gaps;
}
