import { createHmac } from 'node:crypto';
import { PostHog } from 'posthog-node';

const MICRO_CENTS_PER_USD = 100_000_000;

type AiToolCall = {
  id?: string;
  function: {
    name: string;
    arguments: string;
  };
};

export interface AiGenerationCapture {
  distinctId: string;
  userId?: string;
  traceId: string;
  sessionId?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  latencySeconds: number;
  priorAttemptCount?: number;
  totalCostMicrocents?: number;
  stream?: boolean;
  timeToFirstTokenSeconds?: number;
  stopReason?: string;
  spanId?: string;
  isError?: boolean;
  error?: string;
  toolCalls?: readonly AiToolCall[];
}

let client: PostHog | null = null;

/**
 * Keyed HMAC-SHA256 pseudonymization.
 * Fail-closed: returns undefined if the salt is absent or empty.
 */
export function pseudonymizeIdentity(id?: string | null, salt?: string): string | undefined {
  if (!id) return undefined;
  const activeSalt = salt ?? process.env.POSTHOG_IDENTITY_SALT?.trim();
  if (!activeSalt) return undefined;
  return createHmac('sha256', activeSalt).update(id).digest('hex');
}

/**
 * Derives a privacy-safe distinctId for PostHog AI observability.
 * Never leaks raw layerIdentityId or un-salted identifiers.
 */
export function resolveDistinctId(args: {
  layerIdentityId?: string | null;
  teamId: string;
  salt?: string;
}): string {
  const activeSalt = args.salt ?? process.env.POSTHOG_IDENTITY_SALT?.trim();
  if (!activeSalt) return 'anon_unidentified';

  if (args.layerIdentityId) {
    const userPseudo = pseudonymizeIdentity(args.layerIdentityId, activeSalt);
    if (userPseudo) return `user_${userPseudo.slice(0, 32)}`;
  }
  const teamPseudo = pseudonymizeIdentity(args.teamId, activeSalt);
  if (teamPseudo) return `team_${teamPseudo.slice(0, 32)}`;
  return 'anon_unidentified';
}

/** Initialize server-side AI observability only when explicitly configured. */
export function initPostHog(): void {
  if (client) return;
  const apiKey = process.env.POSTHOG_API_KEY?.trim();
  const host = process.env.POSTHOG_HOST?.trim();
  if (!apiKey || !host) return;

  try {
    client = new PostHog(apiKey, {
      host,
    });
  } catch (error) {
    console.error('[posthog] failed to initialize PostHog client:', error);
  }
}

export function buildAiGenerationProperties(args: AiGenerationCapture): Record<string, unknown> {
  const spanId = args.spanId ?? `${args.traceId}:generation`;
  // RouteShift publicly promises not to store prompts or completions
  // (apps/dashboard/app/landing-client.tsx), so generation events contain
  // telemetry only; never add message or tool-argument content here.
  const properties: Record<string, unknown> = {
    $ai_trace_id: args.traceId,
    $ai_span_id: spanId,
    $ai_model: args.model,
    $ai_provider: args.provider,
  };

  // Fail-closed user_id: only emitted when pseudonymized
  if (args.userId) {
    properties.user_id = args.userId;
  }
  if (args.sessionId) {
    properties.$ai_session_id = args.sessionId;
  }

  if (args.isError) {
    properties.$ai_is_error = true;
    if (args.error) {
      properties.$ai_error = args.error;
    }
  }

  // Multi-attempt requests: token aggregates span ALL dispatched attempts while
  // model/provider reflect only the successful one — attribute nothing
  // misleading. Only the first attempt (no prior attempts) may carry token and
  // latency values (cross-review P2).
  if ((args.priorAttemptCount ?? 0) === 0) {
    properties.$ai_input_tokens = args.inputTokens;
    properties.$ai_output_tokens = args.outputTokens;
    properties.$ai_latency = args.latencySeconds;
  }

  if (
    args.totalCostMicrocents !== undefined
    && Number.isFinite(args.totalCostMicrocents)
  ) {
    properties.$ai_total_cost_usd = args.totalCostMicrocents / MICRO_CENTS_PER_USD;
  }

  if (args.stream !== undefined) properties.$ai_stream = args.stream;
  if (args.timeToFirstTokenSeconds !== undefined && Number.isFinite(args.timeToFirstTokenSeconds)) {
    properties.$ai_time_to_first_token = args.timeToFirstTokenSeconds;
  }
  if (args.stopReason) properties.$ai_stop_reason = args.stopReason;

  return properties;
}

/** Capture one completed LLM generation and optional model-requested tool spans. */
export function captureAiGeneration(args: AiGenerationCapture): void {
  if (!client) return;

  const generationSpanId = args.spanId ?? `${args.traceId}:generation`;
  try {
    client.capture({
      distinctId: args.distinctId,
      event: '$ai_generation',
      properties: buildAiGenerationProperties(args),
    });

    const toolCalls = args.toolCalls ?? [];
    for (const [index] of toolCalls.entries()) {
      const toolProperties: Record<string, unknown> = {
        $ai_trace_id: args.traceId,
        $ai_span_id: `${args.traceId}:tool:${index}`,
        $ai_parent_id: generationSpanId,
        $ai_span_name: 'tool_call',
        toolCount: toolCalls.length,
        toolIndex: index,
      };
      if (args.userId) toolProperties.user_id = args.userId;
      if (args.sessionId) toolProperties.$ai_session_id = args.sessionId;

      client.capture({
        distinctId: args.distinctId,
        event: '$ai_span',
        properties: toolProperties,
      });
    }
  } catch (error) {
    // PostHog is strictly best effort; preserve the served response on SDK errors.
    console.error('[posthog] AI observability capture failed:', error);
  }
}

export async function flushPostHog(timeoutMs = 2_000): Promise<void> {
  if (!client) return;
  try {
    await client.shutdown(timeoutMs);
  } catch (error) {
    console.error('[posthog] shutdown failed:', error);
  } finally {
    client = null;
  }
}
