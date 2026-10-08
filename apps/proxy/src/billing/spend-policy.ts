import type { BudgetStatus } from '@routeshift/shared';

export type SpendPolicyWindow =
  | { kind: 'fixed'; starts_at: Date; ends_at: Date }
  | { kind: 'rolling'; duration_ms: number };

export interface SpendPolicyDimensions {
  team_id: string;
  api_key_id?: string;
  provider?: string;
  model?: string;
  /** Only tags produced by trusted server-side routing may enter this field. */
  trusted_tags?: readonly string[];
}

export interface SpendPolicy {
  id: string;
  enabled: boolean;
  priority: number;
  window: SpendPolicyWindow;
  dimensions: Partial<SpendPolicyDimensions>;
  limit_microcents: number;
  action: Exclude<BudgetStatus, 'ok'>;
}

export interface SpendPolicyEvaluation {
  status: BudgetStatus;
  policy_id?: string;
  reason?: string;
}

const SEVERITY: Record<BudgetStatus, number> = { ok: 0, alert: 1, throttle: 2, block: 3 };
const invalid = (): SpendPolicyEvaluation => ({ status: 'block', reason: 'invalid_spend_policy' });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function validDimensions(value: unknown): value is SpendPolicyDimensions {
  if (!isRecord(value) || typeof value.team_id !== 'string') return false;
  for (const key of ['api_key_id', 'provider', 'model'] as const) if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  return value.trusted_tags === undefined || (Array.isArray(value.trusted_tags) && value.trusted_tags.every((tag) => typeof tag === 'string'));
}

function validPolicy(value: unknown): value is SpendPolicy {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.priority) || !Number.isSafeInteger(value.limit_microcents) || (value.limit_microcents as number) < 0
    || !['alert', 'throttle', 'block'].includes(value.action as string) || !validDimensions(value.dimensions) || !isRecord(value.window)) return false;
  if (value.window.kind === 'rolling') return Number.isSafeInteger(value.window.duration_ms) && (value.window.duration_ms as number) > 0;
  return value.window.kind === 'fixed' && value.window.starts_at instanceof Date && !Number.isNaN(value.window.starts_at.valueOf())
    && value.window.ends_at instanceof Date && !Number.isNaN(value.window.ends_at.valueOf()) && value.window.starts_at < value.window.ends_at;
}

function matches(policy: SpendPolicy, dimensions: SpendPolicyDimensions): boolean {
  const expected = policy.dimensions;
  if (expected.team_id !== undefined && expected.team_id !== dimensions.team_id) return false;
  if (expected.api_key_id !== undefined && expected.api_key_id !== dimensions.api_key_id) return false;
  if (expected.provider !== undefined && expected.provider !== dimensions.provider) return false;
  if (expected.model !== undefined && expected.model !== dimensions.model) return false;
  return expected.trusted_tags === undefined || expected.trusted_tags.every((tag) => dimensions.trusted_tags?.includes(tag));
}

/** Pure, fail-closed evaluator. Callers supply already-accounted spend; it never selects a model. */
export function evaluateSpendPolicies(
  policies: readonly SpendPolicy[],
  dimensions: SpendPolicyDimensions,
  spend_microcents: number,
  predicted_cost_microcents: number,
  now = new Date(),
): SpendPolicyEvaluation {
  if (!Array.isArray(policies) || !validDimensions(dimensions) || !(now instanceof Date) || Number.isNaN(now.valueOf())) return invalid();
  if (!Number.isSafeInteger(spend_microcents) || !Number.isSafeInteger(predicted_cost_microcents)
    || spend_microcents < 0 || predicted_cost_microcents < 0) {
    return invalid();
  }
  let result: SpendPolicyEvaluation = { status: 'ok' };
  for (const policy of policies) {
    if (!validPolicy(policy)) return invalid();
    if (!policy.enabled || !matches(policy, dimensions)) continue;
    if (policy.window.kind === 'fixed' && (now < policy.window.starts_at || now >= policy.window.ends_at)) continue;
    if (spend_microcents + predicted_cost_microcents < policy.limit_microcents) continue;
    if (SEVERITY[policy.action] > SEVERITY[result.status]
      || (SEVERITY[policy.action] === SEVERITY[result.status] && (policy.priority < (policies.find((p) => p.id === result.policy_id)?.priority ?? Infinity)))) {
      result = { status: policy.action, policy_id: policy.id, reason: `spend_policy_${policy.id}_${policy.action}` };
    }
  }
  return result;
}
