/**
 * RSH-138 pre-dispatch budget estimation. Conservative upper bounds only:
 * the chat estimate covers the primary plus every fallback the retry policy
 * can dispatch (composed through the quality-cascade reservation projection),
 * plus the configured maximum plugin surcharge; the credits markup is never
 * applied because budget caps measure customer spend in raw microcents.
 *
 * Estimates are advisory inputs to admission only — settlement always uses
 * measured provider usage.
 */

import type { CanonicalRequest } from '@routeshift/shared';
import { getCreditPricing } from './credits.js';
import {
  projectQualityCascadeReservation,
  type FallbackEntry,
  type RetryBudget,
} from '../routing/fallback.js';
import { computeRequestCostDetailed } from '../cost/calculator.js';

export interface BudgetEstimate {
  /** Null when any dispatchable candidate has no pricing; hard caps fail closed. */
  estimatedMicrocents: number | null;
  missingPricing?: { provider: string; model: string };
}

export interface ChatBudgetEstimateInput {
  originalModel: string;
  originalProvider: string;
  provider: string;
  model: string;
  canonical: CanonicalRequest;
  fallbackChain: readonly FallbackEntry[];
  retryBudget: RetryBudget;
  pluginSurchargeMicrocents: number;
}

export async function estimateChatBudget(input: ChatBudgetEstimateInput): Promise<BudgetEstimate> {
  const projection = await projectQualityCascadeReservation(
    { provider: input.provider, model: input.model },
    [...input.fallbackChain],
    input.canonical,
    {
      ...input.retryBudget,
      // Budget caps price subscription traffic too — the same resolver regardless.
      pricingResolver: getCreditPricing,
    },
  );

  if (projection.missingPricing) {
    return {
      estimatedMicrocents: null,
      missingPricing: {
        provider: projection.missingPricing.provider,
        model: projection.missingPricing.model,
      },
    };
  }

  return {
    estimatedMicrocents: projection.costMicrocents + input.pluginSurchargeMicrocents,
  };
}

/**
 * Conservative upper bound for embedding tokenizer behavior without a provider
 * tokenizer call: each UTF-8 byte is at most one token across current
 * embedding tokenizers, plus one token of per-item overhead. Deliberately
 * conservative for dense CJK/emoji inputs (≈1 token per character) and far
 * more conservative for ASCII.
 */
export function utf8TokenUpperBound(inputItems: readonly string[]): number {
  let total = 0;
  for (const item of inputItems) {
    total += Buffer.byteLength(item, 'utf8') + 1;
  }
  return total;
}

export async function estimateEmbeddingBudget(input: {
  provider: string;
  model: string;
  inputTokens: number;
}): Promise<BudgetEstimate> {
  const cost = await computeRequestCostDetailed(
    input.model,
    input.provider,
    input.model,
    input.provider,
    {
      input_tokens: input.inputTokens,
      output_tokens: 0,
      total_tokens: input.inputTokens,
    },
  );

  if (!cost.actual_cost_known) {
    return {
      estimatedMicrocents: null,
      missingPricing: { provider: input.provider, model: input.model },
    };
  }

  return { estimatedMicrocents: cost.actual_cost_microcents };
}
