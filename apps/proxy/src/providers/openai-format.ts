import { randomUUID } from 'node:crypto';
import type { CanonicalResponse, StopReason } from '@routeshift/shared';

/**
 * RouteShift is a routing gateway: the same request can be served by different
 * providers (fallback, load-balancing, cost routing) without the caller's
 * knowledge. So the non-streaming response must present ONE stable contract
 * regardless of upstream — the OpenAI chat-completion shape, matching the
 * already-canonical streaming path.
 *
 * OpenAI-native upstreams already emit this shape and are passed through
 * untouched (see isOpenAIShapedBody) to preserve provider-specific fields like
 * logprobs/system_fingerprint/multiple choices. Foreign shapes (Anthropic
 * content[], Gemini candidates) are rebuilt from the canonical response here,
 * with the original upstream body attached as `raw` so power users can still
 * read provider-native fields.
 */

/** True when the upstream body is already an OpenAI chat-completion (has choices[]). */
export function isOpenAIShapedBody(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && Array.isArray((body as { choices?: unknown }).choices));
}

const STOP_REASON_TO_FINISH: Record<StopReason, string> = {
  end: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  safety: 'content_filter',
  error: 'stop',
};

export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        extra_content?: { google?: { thought_signature?: string } };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: { reasoning_tokens: number };
  };
  /** Untouched upstream provider body, for callers needing provider-native fields. */
  raw: unknown;
}

/**
 * Serialize a canonical response (from a non-OpenAI provider) into the OpenAI
 * chat-completion shape, attaching the original upstream body as `raw`.
 */
export function toOpenAIChatCompletion(
  canonical: CanonicalResponse,
  model: string,
  raw: unknown,
  nowMs: number = Date.now(),
): OpenAIChatCompletion {
  const hasToolCalls = Boolean(canonical.tool_calls && canonical.tool_calls.length > 0);
  return {
    id: canonical.id || `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(nowMs / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          // OpenAI sends content: null when the turn is purely tool calls.
          content: hasToolCalls && !canonical.content ? null : canonical.content,
          ...(hasToolCalls
            ? {
                tool_calls: canonical.tool_calls!.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.function.name, arguments: tc.function.arguments },
                  ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
                })),
              }
            : {}),
        },
        finish_reason: STOP_REASON_TO_FINISH[canonical.stop_reason] ?? 'stop',
      },
    ],
    usage: {
      prompt_tokens: canonical.usage.input_tokens,
      completion_tokens: canonical.usage.output_tokens,
      total_tokens: canonical.usage.total_tokens,
      ...(canonical.usage.reasoning_tokens !== undefined
        ? { completion_tokens_details: { reasoning_tokens: canonical.usage.reasoning_tokens } }
        : {}),
    },
    raw,
  };
}
