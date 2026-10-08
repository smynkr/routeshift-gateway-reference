import { randomUUID } from 'node:crypto';
import type {
  CanonicalContentPart,
  CanonicalRequest,
  CanonicalMessage,
  CanonicalResponse,
  CanonicalStreamChunk,
  CanonicalToolCall,
  CanonicalToolChoice,
  TokenUsage,
  StopReason,
  ProviderOutcomeSignals,
} from '@routeshift/shared';
import { ProxyError } from '@routeshift/shared';
import type { SSEEvent } from '../streaming/sse-parser.js';
import type { EmbeddingOptions, LLMProvider, ProviderRequest } from './types.js';

// Raw Gemini finishReasons this adapter recognizes (the documented FinishReason
// enum). The SAFETY_FINISH_REASONS subset are safety blocks. Anything else is
// preserved exactly and flagged via unknown_fields_present.
const KNOWN_FINISH_REASONS = new Set([
  'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER',
  'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL',
]);
const SAFETY_FINISH_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);
// Documented Gemini promptFeedback.blockReason values; an unrecognized one is an
// unknown raw outcome and must set unknown_fields_present (fail loud).
const KNOWN_BLOCK_REASONS = new Set([
  'BLOCK_REASON_UNSPECIFIED', 'SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY',
]);

// Gemini's `usageMetadata.promptTokenCount` is the TOTAL prompt token count
// and already INCLUDES `cachedContentTokenCount` (unlike Anthropic, which
// reports cache tokens separately/additively from input_tokens). Reporting
// promptTokenCount as input_tokens AND cache_read_tokens on top would double
// bill the cached portion (calculateCostMicrocents sums input + cache_read).
// Subtract the cached count from input_tokens so the two fields are
// non-overlapping, like Anthropic's.
function usageFromGemini(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
} | undefined): TokenUsage {
  const promptTokens = usage?.promptTokenCount ?? 0;
  const cachedTokens = usage?.cachedContentTokenCount ?? 0;
  const reasoningTokens = usage?.thoughtsTokenCount ?? 0;
  return {
    input_tokens: promptTokens - cachedTokens,
    // Gemini bills thought tokens as output. Include them in the canonical
    // output count so cost, request logs, cache-hit reconciliation, and usage
    // summaries agree; retain the split for OpenAI-compatible telemetry.
    output_tokens: (usage?.candidatesTokenCount ?? 0) + reasoningTokens,
    total_tokens: usage?.totalTokenCount ?? 0,
    cache_read_tokens: cachedTokens,
    ...(usage?.thoughtsTokenCount !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
  };
}

type GeminiThinkingLevel = NonNullable<CanonicalRequest['thinking_level']>;

function isGemini3OrLater(model: string): boolean {
  return /^gemini-3(?:[.-]|$)/.test(model);
}

function supportedThinkingLevels(model: string): readonly GeminiThinkingLevel[] {
  // Gemini 3.1 Pro cannot be set to minimal. Gemini 3 Pro supports low/high
  // only; other currently supported Gemini 3 request models accept all four.
  if (/^gemini-3\.1-pro(?:[.-]|$)/.test(model)) return ['low', 'medium', 'high'];
  if (/^gemini-3-pro(?:[.-]|$)/.test(model)) return ['low', 'high'];
  return ['minimal', 'low', 'medium', 'high'];
}

function thinkingLevelFromEffort(effort: CanonicalRequest['reasoning_effort']): GeminiThinkingLevel | undefined {
  return effort;
}

function thinkingBudgetFromEffort(effort: CanonicalRequest['reasoning_effort']): number | undefined {
  switch (effort) {
    case 'low': return 1_024;
    case 'medium': return 8_192;
    case 'high': return 24_576;
    default: return undefined;
  }
}

/** Builds the model-aware Gemini thinking config or fails before any upstream
 * request. The message is intentionally specific: callers must be able to
 * distinguish an unsupported level from an invalid levels/budget combination. */
export function geminiThinkingConfig(req: CanonicalRequest): Record<string, unknown> | undefined {
  const explicitLevel = req.thinking_level;
  const level = explicitLevel ?? thinkingLevelFromEffort(req.reasoning_effort);
  const budget = req.thinking_budget_tokens;
  const gemini3 = isGemini3OrLater(req.model);

  if (gemini3) {
    if (level !== undefined && budget !== undefined) {
      throw new Error('Gemini thinking_level/reasoning_effort cannot be combined with thinking_budget_tokens for Gemini 3+ models');
    }
    if (level !== undefined) {
      const supported = supportedThinkingLevels(req.model);
      if (!supported.includes(level)) {
        throw new Error(`Gemini model ${req.model} does not support thinking_level '${level}'; supported levels: ${supported.join(', ')}`);
      }
      return { thinkingLevel: level };
    }
    // The Gemini API still accepts thinkingBudget for backwards compatibility
    // on Gemini 3 when no level is selected. Preserve existing callers rather
    // than silently changing their request semantics.
    return budget !== undefined ? { thinkingBudget: budget } : undefined;
  }

  if (explicitLevel !== undefined) {
    throw new Error(`Gemini model ${req.model} does not support thinking_level; use thinking_budget_tokens for Gemini 2.5 models`);
  }
  const effectiveBudget = budget ?? thinkingBudgetFromEffort(req.reasoning_effort);
  return effectiveBudget !== undefined ? { thinkingBudget: effectiveBudget } : undefined;
}

class UnsupportedEmbeddingOptionsError extends Error {
  constructor() {
    super('encoding_format/dimensions/user are not supported for this model');
    this.name = 'UnsupportedEmbeddingOptionsError';
  }
}

/** OpenAI tool-call arguments are a JSON string; Gemini `functionCall.args`
 *  must be an object. Parse defensively — malformed/empty becomes {}. */
function parseToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class GeminiProvider implements LLMProvider {
  readonly id = 'google';

  constructor(private baseUrl: string = 'https://generativelanguage.googleapis.com') {}

  buildRequest(req: CanonicalRequest, apiKey: string): ProviderRequest {
    const contents = this.toContents(req.messages, req.model);

    const body: Record<string, unknown> = { contents };

    if (req.system_prompt) {
      body.systemInstruction = { parts: this.systemParts(req.system_prompt) };
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((tool) => {
            const decl: Record<string, unknown> = {
              name: tool.function.name,
              description: tool.function.description,
            };
            // The OpenAI `parameters` object is JSON Schema. Route it to Gemini's
            // JSON-Schema-native `parametersJsonSchema` (mutually exclusive with the
            // OpenAPI-subset `parameters` field) so schemas using additionalProperties
            // / $ref / etc. validate instead of 400ing. Omit when the tool takes none.
            if (tool.function.parameters !== undefined) {
              decl.parametersJsonSchema = tool.function.parameters;
            }
            return decl;
          }),
        },
      ];
    }

    const toolConfig = this.toolConfig(req.tool_choice);
    if (toolConfig) body.toolConfig = toolConfig;

    const genConfig: Record<string, unknown> = {};
    if (req.max_output_tokens !== undefined) genConfig.maxOutputTokens = req.max_output_tokens;
    if (req.temperature !== undefined) genConfig.temperature = req.temperature;
    if (typeof req.provider_params?.top_p === 'number') genConfig.topP = req.provider_params.top_p;
    if (typeof req.provider_params?.frequency_penalty === 'number') genConfig.frequencyPenalty = req.provider_params.frequency_penalty;
    if (typeof req.provider_params?.presence_penalty === 'number') genConfig.presencePenalty = req.provider_params.presence_penalty;
    const stop = req.provider_params?.stop;
    if (typeof stop === 'string') {
      genConfig.stopSequences = [stop];
    } else if (Array.isArray(stop) && stop.every((entry) => typeof entry === 'string')) {
      genConfig.stopSequences = stop;
    }

    const thinkingConfig = geminiThinkingConfig(req);
    if (thinkingConfig) genConfig.thinkingConfig = thinkingConfig;

    // Structured output: map response_format onto Gemini's JSON-Schema-native
    // generationConfig fields. A concrete schema goes to responseJsonSchema (the
    // lossless JSON-Schema field, mutually exclusive with the OpenAPI-subset
    // responseSchema); any non-text contract sets responseMimeType. response_format
    // reaches us in either the OpenAI shape ({type:'json_object'} |
    // {type:'json_schema', json_schema:{schema}}) or the repo-internal
    // {type:'json', schema}.
    const rf = req.response_format;
    if (rf && rf.type !== 'text') {
      genConfig.responseMimeType = 'application/json';
      const schema = rf.type === 'json_schema' ? rf.json_schema?.schema : rf.schema;
      if (schema) genConfig.responseJsonSchema = schema;
    }

    if (Object.keys(genConfig).length > 0) body.generationConfig = genConfig;

    const action = req.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${this.baseUrl}/v1beta/models/${req.model}:${action}`;

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    };
  }

  /** Translate one canonical message into a Gemini `content`. An assistant turn's
   *  `tool_calls` become `functionCall` parts (role:'model'); a role:'tool'
   *  result becomes a `functionResponse` part (role:'user'). Plain messages map
   *  to a single text part. */
  private toContents(messages: CanonicalMessage[], model: string): Array<Record<string, unknown>> {
    const contents: Array<Record<string, unknown>> = [];
    // Gemini `functionResponse` parts require the function name, while a canonical
    // role:'tool' result carries only its call id. Track only assistant calls that
    // have already appeared, and consume each one after its first result so an
    // invalid transcript cannot bind to a future or duplicate call.
    const availableToolCalls = new Map<string, string>();
    for (const [index, msg] of messages.entries()) {
      if (msg.role !== 'tool' && availableToolCalls.size > 0) {
        const unresolvedIds = [...availableToolCalls.keys()].join(', ');
        throw new ProxyError(
          `Gemini function responses remain unresolved before ${msg.role} message: ${unresolvedIds}`,
          400,
          false,
          'google',
        );
      }
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const toolCall of msg.tool_calls) {
          availableToolCalls.set(toolCall.id, toolCall.function.name);
        }
      }
      const content = this.toContent(msg, availableToolCalls, model);
      const previousMessage = messages[index - 1];
      if (msg.role === 'tool' && previousMessage?.role === 'tool') {
        const previousParts = contents.at(-1)?.parts as Array<Record<string, unknown>>;
        const currentParts = content.parts as Array<Record<string, unknown>>;
        previousParts.push(...currentParts);
      } else {
        contents.push(content);
      }
    }
    return contents;
  }

  private toContent(
    msg: CanonicalMessage,
    availableToolCalls: Map<string, string>,
    model: string,
  ): Record<string, unknown> {
    if (msg.role === 'tool') {
      if (!msg.tool_call_id) {
        throw new ProxyError('Gemini tool result is missing tool_call_id', 400, false, 'google');
      }
      const name = availableToolCalls.get(msg.tool_call_id);
      if (!name) {
        throw new ProxyError(`Gemini tool result references unknown tool_call_id: ${msg.tool_call_id}`, 400, false, 'google');
      }
      availableToolCalls.delete(msg.tool_call_id);
      const result: Record<string, unknown> = {
        name,
        response: { result: this.functionResponseValue(msg.content) },
        id: msg.tool_call_id,
      };
      const mediaParts = this.functionResponseMediaParts(msg.content);
      if (mediaParts.length > 0) {
        if (!model.includes('gemini-3')) {
          throw new ProxyError(
            `Gemini multimodal function responses require a Gemini 3 model, received "${model}"`,
            400,
            false,
            'google',
          );
        }
        result.parts = mediaParts;
      }
      return { role: 'user', parts: [{ functionResponse: result }] };
    }

    const role = msg.role === 'assistant' ? 'model' : msg.role;

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const parts: Array<Record<string, unknown>> = Array.isArray(msg.content)
        ? this.toParts(msg.content)
        : msg.content.length > 0
          ? [{ text: msg.content }]
          : [];
      for (const tc of msg.tool_calls) {
        const functionCall: Record<string, unknown> = { name: tc.function.name };
        if (tc.id) functionCall.id = tc.id;
        functionCall.args = parseToolArgs(tc.function.arguments);
        const part: Record<string, unknown> = { functionCall };
        const thoughtSignature = tc.extra_content?.google?.thought_signature;
        if (thoughtSignature) part.thoughtSignature = thoughtSignature;
        parts.push(part);
      }
      return { role, parts };
    }

    return { role, parts: this.toParts(msg.content) };
  }

  private toParts(content: CanonicalMessage['content']): Array<Record<string, unknown>> {
    if (!Array.isArray(content)) return [{ text: content }];
    return content.map((part) => this.toPart(part));
  }

  private functionResponseValue(content: CanonicalMessage['content']): unknown {
    if (!Array.isArray(content)) return content;
    const text = content.flatMap((part) => (
      part.type === 'text' ? [part.text ?? ''] : []
    ));
    return text.length === 1 ? text[0] : text;
  }

  private functionResponseMediaParts(
    content: CanonicalMessage['content'],
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (part.type === 'pdf') {
        return [{
          inlineData: {
            mimeType: part.pdf.media_type,
            data: part.pdf.data,
          },
        }];
      }
      if (part.type !== 'image_url' || !part.image_url?.url) return [];
      const dataUrl = /^data:(image\/(?:gif|jpeg|png|webp));base64,(.+)$/s.exec(part.image_url.url);
      if (!dataUrl) {
        throw new ProxyError(
          'Gemini multimodal function responses require inline data image URLs',
          400,
          false,
          'google',
        );
      }
      return [{ inlineData: { mimeType: dataUrl[1], data: dataUrl[2] } }];
    });
  }

  private systemParts(systemPrompt: CanonicalRequest['system_prompt']): Array<Record<string, unknown>> {
    if (typeof systemPrompt === 'string') return [{ text: systemPrompt }];
    if (!Array.isArray(systemPrompt)) return [];
    // Gemini systemInstruction accepts text parts, not Anthropic/OpenAI block
    // metadata. System files are intentionally extracted to text before this
    // adapter, while cache_control and other provider-specific fields must not
    // be forwarded as invalid Gemini payloads.
    return systemPrompt.flatMap((part) => (
      typeof part.text === 'string' ? [{ text: part.text }] : []
    ));
  }

  private toPart(part: CanonicalContentPart): Record<string, unknown> {
    if (part.type === 'pdf') {
      return {
        inlineData: {
          mimeType: part.pdf.media_type,
          data: part.pdf.data,
        },
      };
    }
    if (part.type === 'text') return { text: part.text ?? '' };
    // Existing OpenAI-shaped image URL parts remain unchanged here. Native PDF
    // support is intentionally isolated from the separately-scoped image
    // adapter work rather than guessing an inline-data encoding for a URL.
    return part as unknown as Record<string, unknown>;
  }

  /** Map canonical tool_choice to Gemini's functionCallingConfig. */
  private toolConfig(choice: CanonicalToolChoice | undefined): Record<string, unknown> | undefined {
    if (choice === undefined) return undefined;
    if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
    if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
    if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } };
    if (typeof choice === 'object' && choice.function?.name) {
      return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.function.name] } };
    }
    return undefined;
  }

  /** Extract every `functionCall` part from a candidate (parallel calls included). */
  private functionCalls(candidate: any): Array<{ id?: string; name?: string; args?: unknown; thoughtSignature?: string }> {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) return [];
    return parts
      .filter((p: any) => p?.functionCall)
      .map((p: any) => ({
        ...p.functionCall,
        ...(typeof p.thoughtSignature === 'string' ? { thoughtSignature: p.thoughtSignature } : {}),
      }));
  }

  private toolCallDelta(fc: { id?: string; name?: string; args?: unknown; thoughtSignature?: string }, index: number): CanonicalStreamChunk {
    return {
      type: 'tool_call_delta',
      tool_call: {
        // Gemini < 3 omits the id when streaming; synthesize one (matching the
        // non-streaming parseResponse) so the client has a stable id to replay
        // in the tool result — an empty id can't be mapped back to a function
        // name on the next turn. Gemini sends each functionCall complete in one
        // chunk, so one id per call is correct.
        id: fc.id ?? randomUUID(),
        name: fc.name ?? '',
        arguments_delta: JSON.stringify(fc.args ?? {}),
        index,
        ...(fc.thoughtSignature
          ? { extra_content: { google: { thought_signature: fc.thoughtSignature } } }
          : {}),
      },
    };
  }

  /** Concatenate the text of every part, not just parts[0]. Gemini can split a
   *  single candidate's content across multiple text parts; reading only the
   *  first silently truncated the response. */
  private partsText(candidate: any): string {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) return '';
    return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  }

  parseResponse(body: unknown): CanonicalResponse {
    const data = body as any;
    const candidate = data.candidates?.[0];
    const text = this.partsText(candidate);
    // Gemini returns tool calls as `functionCall` parts with args pre-parsed; the
    // OpenAI contract expects a JSON string in `function.arguments`, so
    // re-serialize. Older Gemini models omit the id — generate one so the client
    // can correlate the eventual tool result.
    const toolCalls: CanonicalToolCall[] = this.functionCalls(candidate).map((fc) => ({
      id: fc.id ?? randomUUID(),
      type: 'function',
      function: { name: fc.name ?? '', arguments: JSON.stringify(fc.args ?? {}) },
      ...(fc.thoughtSignature
        ? { extra_content: { google: { thought_signature: fc.thoughtSignature } } }
        : {}),
    }));
    const usage = data.usageMetadata ?? {};
    return {
      id: randomUUID(),
      model: '',
      content: text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      stop_reason: toolCalls.length > 0 ? 'tool_use' : this.mapFinishReason(candidate?.finishReason),
      usage: usageFromGemini(usage),
    };
  }

  parseOutcomeSignals(body: unknown): ProviderOutcomeSignals {
    const data = body as any;
    const candidate = data?.candidates?.[0];
    const rawStopReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : null;
    // A blocked prompt reports promptFeedback.blockReason and usually no
    // candidates; capture the block reason and treat it as a safety block.
    const blockReason = typeof data?.promptFeedback?.blockReason === 'string' ? data.promptFeedback.blockReason : null;
    const safetyBlocked = blockReason !== null || (rawStopReason !== null && SAFETY_FINISH_REASONS.has(rawStopReason));
    return {
      provider: this.id,
      raw_stop_reason: rawStopReason,
      refusal: null,
      safety_blocked: safetyBlocked ? true : null,
      prompt_block_reason: blockReason,
      provider_parse_status: data !== null && typeof data === 'object' && !Array.isArray(data) ? 'parsed' : 'failed',
      unknown_fields_present:
        (rawStopReason !== null && !KNOWN_FINISH_REASONS.has(rawStopReason)) ||
        (blockReason !== null && !KNOWN_BLOCK_REASONS.has(blockReason)),
    };
  }

  parseStreamChunk(event: SSEEvent): CanonicalStreamChunk | CanonicalStreamChunk[] | null {
    let data: any;
    try {
      data = JSON.parse(event.data);
    } catch {
      return null;
    }
    const candidate = data.candidates?.[0];

    if (!candidate) {
      // A terminal/usage-only chunk can carry usageMetadata without a candidate.
      // Capture it as a usage chunk so billing doesn't fall back to the char/4
      // estimate (input_tokens=0 → systematic under-billing). Mirrors the OpenAI
      // adapter's handling of the trailing usage-only chunk.
      if (data.usageMetadata) {
        return {
          type: 'usage',
          usage: usageFromGemini(data.usageMetadata),
        };
      }
      return null;
    }

    const fnCalls = this.functionCalls(candidate);
    const finishReason = candidate.finishReason;
    const text = this.partsText(candidate);

    if (finishReason) {
      const done: CanonicalStreamChunk = {
        type: 'done',
        // A bundled functionCall is a tool turn even though Gemini reports STOP.
        stop_reason: fnCalls.length > 0 ? 'tool_use' : this.mapFinishReason(finishReason),
      };
      if (data.usageMetadata) {
        done.usage = usageFromGemini(data.usageMetadata);
      }
      // Gemini's streamGenerateContent?alt=sse frequently bundles the final text
      // (and/or a functionCall) into the same chunk that carries finishReason
      // rather than emitting a separate terminal chunk. Emit that trailing
      // content before the done chunk so streamed responses aren't truncated.
      const leading: CanonicalStreamChunk[] = [];
      if (text) leading.push({ type: 'content_delta', content: text });
      fnCalls.forEach((fc, i) => leading.push(this.toolCallDelta(fc, i)));
      return leading.length > 0 ? [...leading, done] : done;
    }

    // Gemini sends each functionCall complete in a single chunk, so one
    // tool_call_delta per call (with the full id/name/args) reassembles cleanly.
    const out: CanonicalStreamChunk[] = [];
    if (text) out.push({ type: 'content_delta', content: text });
    fnCalls.forEach((fc, i) => out.push(this.toolCallDelta(fc, i)));
    if (out.length === 0) return null;
    return out.length === 1 ? out[0]! : out;
  }

  extractUsage(chunks: CanonicalStreamChunk[]): TokenUsage {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (chunks[i].usage) return chunks[i].usage!;
    }

    const outputText = chunks
      .filter((chunk) => chunk.type === 'content_delta')
      .map((chunk) => chunk.content ?? '')
      .join('');
    const outputTokens = outputText ? Math.ceil(outputText.length / 4) : 0;
    return { input_tokens: 0, output_tokens: outputTokens, total_tokens: outputTokens };
  }

  normalizeError(status: number, body: unknown): ProxyError {
    const data = body as any;
    const message = data?.error?.message ?? 'Unknown Gemini error';
    const retryable = status === 429 || status >= 500;
    return new ProxyError(message, status, retryable, 'google');
  }

  readonly supportsEmbeddings = true;

  buildEmbeddingRequest(input: string | string[], model: string, apiKey: string, opts?: EmbeddingOptions): ProviderRequest {
    if (opts?.encoding_format === 'base64' || opts?.dimensions !== undefined || opts?.user !== undefined) {
      throw new UnsupportedEmbeddingOptionsError();
    }

    // Use this.baseUrl (same as chat buildRequest at L36) so an injected
    // mock-server URL is honored in tests instead of silently hitting prod.
    const base = `${this.baseUrl}/v1beta`;
    if (Array.isArray(input)) {
      return {
        url: `${base}/models/${model}:batchEmbedContents`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ requests: input.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) }),
      };
    }
    return {
      url: `${base}/models/${model}:embedContent`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ content: { parts: [{ text: input }] } }),
    };
  }

  parseEmbeddingResponse(body: unknown): { embeddings: number[][]; usage: TokenUsage } {
    const data = body as any;
    const embeddings: number[][] = data.embeddings
      ? data.embeddings.map((e: any) => (e?.values as number[]) ?? [])
      : [data.embedding?.values as number[]].filter(Boolean);
    // Gemini embeddings responses do not report token usage; cost is computed
    // from an input-token estimate by the embeddings handler (Task 7).
    return { embeddings, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  }

  private mapFinishReason(reason: string | null | undefined): StopReason {
    switch (reason) {
      case 'STOP':
        return 'end';
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'SAFETY':
        return 'safety';
      case 'RECITATION':
        return 'safety';
      default:
        return 'end';
    }
  }
}
