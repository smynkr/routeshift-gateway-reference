import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamChunk,
  TokenUsage,
  StopReason,
  ProviderOutcomeSignals,
} from '@routeshift/shared';
import { ProxyError } from '@routeshift/shared';
import type { SSEEvent } from '../streaming/sse-parser.js';
import type { EmbeddingOptions, LLMProvider, ProviderRequest } from './types.js';

// Raw OpenAI finish_reasons this adapter recognizes. Anything else is preserved
// exactly in raw_stop_reason and flagged via unknown_fields_present so a quality
// gate fails loud instead of silently treating a new outcome as 'end'.
const KNOWN_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);

// OpenAI's `usage.prompt_tokens` is the TOTAL prompt token count and already
// includes both cached and cache-write tokens. Keep ordinary input separate
// from both provider-reported cache classes so cost calculation is additive
// without double counting.
function usageFromOpenAI(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: unknown };
} | undefined): TokenUsage {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens;
  const ordinaryInputTokens = promptTokens - cachedTokens - (cacheWriteTokens ?? 0);
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  const normalizedReasoningTokens = (
    typeof reasoningTokens === 'number'
    && Number.isSafeInteger(reasoningTokens)
    && reasoningTokens >= 0
  )
    ? reasoningTokens
    : undefined;
  return {
    input_tokens: ordinaryInputTokens,
    output_tokens: usage?.completion_tokens ?? 0,
    total_tokens: usage?.total_tokens ?? 0,
    cache_read_tokens: cachedTokens,
    ...(typeof cacheWriteTokens === 'number' ? { cache_write_tokens: cacheWriteTokens } : {}),
    ...(normalizedReasoningTokens !== undefined ? { reasoning_tokens: normalizedReasoningTokens } : {}),
  };
}

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';

  constructor(
    private readonly baseUrlSource: string | ((metadata?: Record<string, unknown>) => string) = 'https://api.openai.com',
  ) {}

  protected resolveBaseUrl(metadata?: Record<string, unknown>): string {
    const source = this.baseUrlSource;
    return typeof source === 'function' ? source(metadata) : source;
  }

  buildRequest(
    req: CanonicalRequest,
    apiKey: string,
    metadata?: Record<string, unknown>,
  ): ProviderRequest {
    const messages: Array<Record<string, unknown>> = [];

    if (req.system_prompt) {
      messages.push({ role: 'system', content: req.system_prompt });
    }
    for (const msg of req.messages) {
      // Preserve OpenAI-compatible multi-turn tool context: an assistant turn's
      // `tool_calls`, and the `tool_call_id` on a following role:'tool' result.
      // Dropping these breaks agent loops — the upstream rejects a tool message
      // with no matching id, and the assistant tool-call turn loses its context.
      // (`content` is null on a pure tool-call assistant turn — OpenAI allows it.)
      const out: Record<string, unknown> = { role: msg.role, content: msg.content ?? null };
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        // Canonical tool calls may contain RouteShift-only provider history
        // (for example Gemini thought signatures). Project explicitly onto the
        // OpenAI wire shape so internal metadata never leaks upstream.
        out.tool_calls = msg.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          type: toolCall.type,
          function: {
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          },
        }));
      }
      if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
      messages.push(out);
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: req.stream,
    };

    if (req.stream) {
      body.stream_options = { include_usage: true };
    }
    if (req.max_output_tokens !== undefined) body.max_completion_tokens = req.max_output_tokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools) body.tools = req.tools;
    if (req.tool_choice) body.tool_choice = req.tool_choice;
    if (req.response_format) body.response_format = req.response_format;
    if (req.reasoning_effort) body.reasoning_effort = req.reasoning_effort;
    if (req.provider_params) {
      for (const key of [
        'top_p',
        'frequency_penalty',
        'presence_penalty',
        'stop',
        'seed',
        'user',
        'logit_bias',
        'logprobs',
        'top_logprobs',
        'n',
      ]) {
        const value = req.provider_params[key];
        if (value === undefined) continue;
        // Match Anthropic/Gemini: only forward a well-formed `stop` (a string or
        // an array of strings). Previously OpenAI passed any value straight
        // through while the other two silently dropped non-strings — drop here
        // too so a malformed stop behaves consistently across providers.
        if (
          key === 'stop' &&
          !(typeof value === 'string' || (Array.isArray(value) && value.every((s) => typeof s === 'string')))
        ) {
          continue;
        }
        body[key] = value;
      }
    }

    const baseUrl = this.resolveBaseUrl(metadata);
    return {
      url: `${baseUrl}/v1/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
  }

  parseResponse(body: unknown): CanonicalResponse {
    const data = body as any;
    const choice = data.choices?.[0];
    const toolCalls = Array.isArray(choice?.message?.tool_calls)
      ? choice.message.tool_calls.map((toolCall: any) => ({
          id: toolCall.id,
          type: 'function' as const,
          function: {
            name: toolCall.function?.name,
            arguments: toolCall.function?.arguments,
          },
          ...(toolCall.extra_content ? { extra_content: toolCall.extra_content } : {}),
        }))
      : [];
    return {
      id: data.id,
      model: data.model,
      content: choice?.message?.content ?? '',
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      stop_reason: this.mapFinishReason(choice?.finish_reason),
      usage: usageFromOpenAI(data.usage),
    };
  }

  parseOutcomeSignals(body: unknown): ProviderOutcomeSignals {
    const data = body as any;
    const choice = data?.choices?.[0];
    const rawStopReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    const hasRefusal = typeof choice?.message?.refusal === 'string' && choice.message.refusal.length > 0;
    return {
      provider: this.id,
      raw_stop_reason: rawStopReason,
      refusal: hasRefusal ? true : null,
      safety_blocked: rawStopReason === 'content_filter' ? true : null,
      prompt_block_reason: null,
      provider_parse_status: data !== null && typeof data === 'object' && !Array.isArray(data) ? 'parsed' : 'failed',
      unknown_fields_present: rawStopReason !== null && !KNOWN_FINISH_REASONS.has(rawStopReason),
    };
  }

  parseStreamChunk(event: SSEEvent): CanonicalStreamChunk | CanonicalStreamChunk[] | null {
    if (event.data === '[DONE]') return null;

    let data: any;
    try {
      data = JSON.parse(event.data);
    } catch {
      return null;
    }
    const choice = data.choices?.[0];
    if (!choice) {
      // With stream_options.include_usage, OpenAI/Azure emit a final chunk
      // that has an empty `choices` array and the real token usage populated.
      // It arrives separately from (and after) the finish_reason chunk, whose
      // own `usage` is null. Capture it here as a usage chunk — otherwise it is
      // dropped before the usage check below and billing falls back to the
      // char/4 estimate with input_tokens=0 (systematic under-billing).
      if (data.usage) {
        return {
          type: 'usage',
          usage: usageFromOpenAI(data.usage),
        };
      }
      return null;
    }

    const delta = choice.delta ?? {};
    const finishReason = choice.finish_reason;

    if (finishReason) {
      const chunk: CanonicalStreamChunk = {
        type: 'done',
        stop_reason: this.mapFinishReason(finishReason),
      };
      if (data.usage) {
        chunk.usage = usageFromOpenAI(data.usage);
      }
      return chunk;
    }

    if (delta.content) {
      return { type: 'content_delta', content: delta.content };
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      // OpenAI streams the tool id/name only on each tool's first delta;
      // continuation deltas (and parallel tool calls) carry just `index` +
      // argument fragments. Emit every entry with its index — reading only
      // tool_calls[0] dropped parallel tools, and omitting `index` collapsed
      // continuation deltas (which have no id) into one bogus tool call.
      const toolChunks: CanonicalStreamChunk[] = delta.tool_calls.map((tc: any) => ({
        type: 'tool_call_delta' as const,
        tool_call: {
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
          arguments_delta: tc.function?.arguments ?? '',
          index: tc.index,
        },
      }));
      return toolChunks.length === 1 ? toolChunks[0]! : toolChunks;
    }

    return null;
  }

  extractUsage(chunks: CanonicalStreamChunk[]): TokenUsage {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (chunks[i].usage) return chunks[i].usage!;
    }
    // Providers with streaming_usage:false (Groq, Qwen) never emit a
    // usage chunk. Returning zero tokens here would deduct zero credits
    // — a billing leak. Estimate output tokens from the content delta
    // chars (~4 chars/token) so the cost path attributes something.
    let outputChars = 0;
    for (const c of chunks) {
      if (c.type === 'content_delta' && typeof c.content === 'string') {
        outputChars += c.content.length;
      }
    }
    if (outputChars === 0) {
      return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    }
    const output = Math.ceil(outputChars / 4);
    return {
      input_tokens: 0,
      output_tokens: output,
      total_tokens: output,
    };
  }

  normalizeError(status: number, body: unknown): ProxyError {
    const data = body as any;
    const message = data?.error?.message ?? 'Unknown OpenAI error';
    const retryable = status === 429 || status >= 500;
    return new ProxyError(message, status, retryable, 'openai');
  }

  readonly supportsEmbeddings = true;

  buildEmbeddingRequest(input: string | string[], model: string, apiKey: string, opts?: EmbeddingOptions): ProviderRequest {
    const body: Record<string, unknown> = { model, input };
    if (opts?.dimensions !== undefined) body.dimensions = opts.dimensions;
    if (opts?.encoding_format !== undefined) body.encoding_format = opts.encoding_format;
    if (opts?.user !== undefined) body.user = opts.user;

    return {
      url: `${this.resolveBaseUrl()}/v1/embeddings`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    };
  }

  parseEmbeddingResponse(body: unknown): { embeddings: number[][]; usage: TokenUsage } {
    const data = body as any;
    const embeddings = (data.data ?? []).map((d: any) => d.embedding as number[]);
    return {
      embeddings,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: 0,
        total_tokens: data.usage?.total_tokens ?? data.usage?.prompt_tokens ?? 0,
      },
    };
  }

  private mapFinishReason(reason: string | null | undefined): StopReason {
    switch (reason) {
      case 'stop':
        return 'end';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_use';
      case 'content_filter':
        return 'safety';
      default:
        return 'end';
    }
  }
}
