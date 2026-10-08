const PRESET_PARAM_KEYS = [
  'temperature',
  'max_tokens',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop',
  'reasoning_effort',
  'thinking_level',
  'thinking_budget_tokens',
] as const;

export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const;

type ReasoningValidationError =
  | 'invalid_reasoning_effort'
  | 'invalid_thinking_level'
  | 'invalid_thinking_budget_tokens';

export function validateReasoningParams(value: Record<string, unknown>): ReasoningValidationError | null {
  const reasoningEffort = value.reasoning_effort;
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !REASONING_EFFORTS.includes(reasoningEffort as (typeof REASONING_EFFORTS)[number]))) {
    return 'invalid_reasoning_effort';
  }

  const thinkingLevel = value.thinking_level;
  if (thinkingLevel !== undefined && (typeof thinkingLevel !== 'string' || !THINKING_LEVELS.includes(thinkingLevel as (typeof THINKING_LEVELS)[number]))) {
    return 'invalid_thinking_level';
  }

  const thinkingBudgetTokens = value.thinking_budget_tokens;
  if (thinkingBudgetTokens !== undefined && (typeof thinkingBudgetTokens !== 'number' || !Number.isSafeInteger(thinkingBudgetTokens) || thinkingBudgetTokens <= 0)) {
    return 'invalid_thinking_budget_tokens';
  }

  return null;
}

export function normalizePresetParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const out: Record<string, unknown> = {};
  for (const key of PRESET_PARAM_KEYS) {
    const paramValue = (value as Record<string, unknown>)[key];
    if (paramValue !== undefined) out[key] = paramValue;
  }
  return out;
}
