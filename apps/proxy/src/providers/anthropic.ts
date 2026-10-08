import type {
  CanonicalContentPart,
  CanonicalRequest,
  CanonicalMessage,
  CanonicalResponse,
  CanonicalStreamChunk,
  CanonicalToolCall,
  TokenUsage,
  StopReason,
  ProviderOutcomeSignals,
} from '@routeshift/shared';
import { ProxyError, MODEL_REGISTRY } from '@routeshift/shared';
import type { SSEEvent } from '../streaming/sse-parser.js';
import type { LLMProvider, ProviderRequest } from './types.js';

// Raw Anthropic stop_reasons this adapter recognizes (documented outcomes,
// including the terminal policy ones the canonical StopReason union collapses).
// Anything else is preserved exactly and flagged via unknown_fields_present.
const KNOWN_STOP_REASONS = new Set([
  'end_turn', 'max_tokens', 'tool_use', 'stop_sequence',
  'refusal', 'pause_turn', 'model_context_window_exceeded',
]);

const modelLookup = new Map<string, string>();
for (const m of MODEL_REGISTRY) {
  if (m.provider === 'anthropic') {
    modelLookup.set(m.canonical_name, m.api_model_id);
  }
}

/** OpenAI tool-call arguments are a JSON string; Anthropic `tool_use.input`
 *  must be an object. Parse defensively — a malformed/empty string becomes {}
 *  rather than crashing the request build. */
function parseToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';

  constructor(private baseUrl: string = 'https://api.anthropic.com') {}

  buildRequest(
    req: CanonicalRequest,
    apiKey: string,
    _metadata?: Record<string, unknown>,
  ): ProviderRequest {
    const model = modelLookup.get(req.model) ?? req.model;

    const body: Record<string, unknown> = {
      model,
      messages: this.buildMessages(req.messages),
      max_tokens: req.max_output_tokens ?? 8192,
      stream: req.stream,
    };

    if (req.system_prompt) {
      body.system = req.system_prompt;
    }

    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (typeof req.provider_params?.top_p === 'number') body.top_p = req.provider_params.top_p;
    const stop = req.provider_params?.stop;
    if (typeof stop === 'string') {
      body.stop_sequences = [stop];
    } else if (Array.isArray(stop) && stop.every((entry) => typeof entry === 'string')) {
      body.stop_sequences = stop;
    }

    if (req.thinking_budget_tokens) {
      body.thinking = { type: 'enabled', budget_tokens: req.thinking_budget_tokens };
    }

    if (req.tools) {
      body.tools = req.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      }));
    }

    if (req.tool_choice) {
      if (req.tool_choice === 'auto') {
        body.tool_choice = { type: 'auto' };
      } else if (req.tool_choice === 'none') {
        body.tool_choice = { type: 'none' };
      } else if (req.tool_choice === 'required') {
        body.tool_choice = { type: 'any' };
      } else if (typeof req.tool_choice === 'object') {
        body.tool_choice = { type: 'tool', name: req.tool_choice.function.name };
      }
    }

    return {
      url: `${this.baseUrl}/v1/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    };
  }

  /** Translate canonical (OpenAI-shaped) messages into Anthropic's content-block
   *  format. Anthropic has no 'tool' role: an assistant turn's `tool_calls`
   *  become `tool_use` blocks, and each role:'tool' result becomes a
   *  `tool_result` block carried in a `user` turn. Consecutive tool results are
   *  merged into a single user turn (Anthropic's shape for parallel calls).
   *  Plain messages (no tool fields) pass through unchanged. */
  private buildMessages(messages: CanonicalMessage[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const pendingToolCallIds = new Set<string>();
    let openToolResultTurn: { role: string; content: Array<Record<string, unknown>> } | null = null;

    for (const msg of messages) {
      if (msg.role === 'tool') {
        if (!msg.tool_call_id) {
          throw new ProxyError(
            'Anthropic tool result is missing tool_call_id',
            400,
            false,
            'anthropic',
          );
        }
        if (!pendingToolCallIds.delete(msg.tool_call_id)) {
          throw new ProxyError(
            `Anthropic tool result references unknown tool_call_id "${msg.tool_call_id}"`,
            400,
            false,
            'anthropic',
          );
        }
        const block = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: this.toContent(msg.content),
        };
        if (openToolResultTurn) {
          openToolResultTurn.content.push(block);
        } else {
          openToolResultTurn = { role: 'user', content: [block] };
          out.push(openToolResultTurn);
        }
        continue;
      }

      if (pendingToolCallIds.size > 0) {
        const unresolvedIds = [...pendingToolCallIds].map((id) => `"${id}"`).join(', ');
        throw new ProxyError(
          `Anthropic tool result sequence was interrupted with unresolved tool_call_id(s): ${unresolvedIds}`,
          400,
          false,
          'anthropic',
        );
      }

      // Any non-tool message ends a run of mergeable tool results.
      openToolResultTurn = null;

      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const content: Array<Record<string, unknown>> = [];
        if (typeof msg.content === 'string' && msg.content.length > 0) {
          content.push({ type: 'text', text: msg.content });
        } else if (Array.isArray(msg.content)) {
          content.push(...msg.content.map((part) => this.toContentBlock(part)));
        }
        for (const tc of msg.tool_calls) {
          pendingToolCallIds.add(tc.id);
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parseToolArgs(tc.function.arguments),
          });
        }
        out.push({ role: msg.role, content });
        continue;
      }

      out.push({ role: msg.role, content: this.toContent(msg.content) });
    }

    return out;
  }

  /** Map RouteShift's validated internal PDF part to Anthropic's native
   * document block. Other content remains in the existing canonical shape. */
  private toContent(content: CanonicalMessage['content']): string | Array<Record<string, unknown>> {
    if (!Array.isArray(content)) return content;
    return content.map((part) => this.toContentBlock(part));
  }

  private toContentBlock(part: CanonicalContentPart): Record<string, unknown> {
    if (part.type === 'image_url' && part.image_url?.url) {
      const dataUrl = /^data:(image\/(?:gif|jpeg|png|webp));base64,(.+)$/s.exec(part.image_url.url);
      return {
        type: 'image',
        source: dataUrl
          ? { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] }
          : { type: 'url', url: part.image_url.url },
      };
    }
    if (part.type === 'pdf') {
      return {
        type: 'document',
        source: {
          type: 'base64',
          media_type: part.pdf.media_type,
          data: part.pdf.data,
        },
      };
    }
    return part as unknown as Record<string, unknown>;
  }

  parseResponse(body: unknown): CanonicalResponse {
    const data = body as any;
    let content = '';
    const toolCalls: CanonicalToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        // Anthropic returns tool calls as `tool_use` content blocks with the
        // arguments pre-parsed in `input`. The OpenAI contract expects a JSON
        // string in `function.arguments`, so re-serialize. Dropping these (the
        // prior behavior) left the client a `finish_reason: "tool_calls"`
        // response with empty content and no tool_calls — a broken tool turn.
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }

    return {
      id: data.id,
      model: data.model,
      content,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      stop_reason: this.mapStopReason(data.stop_reason),
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
        total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        // Anthropic reports cached prompt tokens separately from input_tokens,
        // so they are additive for cost (priced via the cache rates).
        cache_read_tokens: data.usage?.cache_read_input_tokens ?? 0,
        cache_write_tokens: data.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }

  parseOutcomeSignals(body: unknown): ProviderOutcomeSignals {
    const data = body as any;
    const rawStopReason = typeof data?.stop_reason === 'string' ? data.stop_reason : null;
    return {
      provider: this.id,
      raw_stop_reason: rawStopReason,
      refusal: rawStopReason === 'refusal' ? true : null,
      // Anthropic surfaces safety blocks as HTTP errors, not 200 stop_reasons,
      // so a successful body carries no positive safety signal here.
      safety_blocked: null,
      prompt_block_reason: null,
      provider_parse_status: data !== null && typeof data === 'object' && !Array.isArray(data) ? 'parsed' : 'failed',
      unknown_fields_present: rawStopReason !== null && !KNOWN_STOP_REASONS.has(rawStopReason),
    };
  }

  parseStreamChunk(event: SSEEvent): CanonicalStreamChunk | null {
    let data: any;
    try {
      data = JSON.parse(event.data);
    } catch {
      return null;
    }

    const eventType = event.event;

    switch (eventType) {
      case 'message_start': {
        const usage = data.message?.usage;
        const inputTokens = usage?.input_tokens ?? 0;
        const outputTokens = usage?.output_tokens ?? 0;
        return {
          type: 'usage',
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
            cache_read_tokens: usage?.cache_read_input_tokens ?? 0,
            cache_write_tokens: usage?.cache_creation_input_tokens ?? 0,
          },
        };
      }

      case 'content_block_delta': {
        const delta = data.delta;
        if (delta?.type === 'text_delta') {
          return { type: 'content_delta', content: delta.text };
        }
        if (delta?.type === 'input_json_delta') {
          // The id/name arrived on content_block_start; continuation deltas carry
          // only the block index, so emit it for the consumer to group by.
          return {
            type: 'tool_call_delta',
            tool_call: {
              id: '',
              name: '',
              arguments_delta: delta.partial_json,
              index: data.index,
            },
          };
        }
        return null;
      }

      case 'message_delta': {
        const outputTokens = data.usage?.output_tokens ?? 0;
        return {
          type: 'done',
          stop_reason: this.mapStopReason(data.delta?.stop_reason),
          usage: {
            input_tokens: 0,
            output_tokens: outputTokens,
            total_tokens: outputTokens,
          },
        };
      }

      case 'message_stop':
        return null;

      case 'content_block_start': {
        // A tool_use block carries the tool's id and name ONLY here; the
        // following input_json_delta chunks omit them. Emit them now (with the
        // block index) so the streamed tool call has a usable id/name — without
        // this the client received tool_call deltas with empty id and name.
        const block = data.content_block;
        if (block?.type === 'tool_use') {
          return {
            type: 'tool_call_delta',
            tool_call: {
              id: block.id ?? '',
              name: block.name ?? '',
              arguments_delta: '',
              index: data.index,
            },
          };
        }
        return null;
      }

      case 'content_block_stop':
      case 'ping':
        return null;

      default:
        return null;
    }
  }

  extractUsage(chunks: CanonicalStreamChunk[]): TokenUsage {
    const startChunk = chunks.find(c => c.type === 'usage');
    const doneChunk = [...chunks].reverse().find(c => c.type === 'done' && c.usage);
    const input = startChunk?.usage?.input_tokens ?? 0;
    const output = doneChunk?.usage?.output_tokens ?? 0;
    return {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      cache_read_tokens: startChunk?.usage?.cache_read_tokens ?? 0,
      cache_write_tokens: startChunk?.usage?.cache_write_tokens ?? 0,
    };
  }

  normalizeError(status: number, body: unknown): ProxyError {
    const data = body as any;
    const message = data?.error?.message ?? 'Unknown Anthropic error';
    const retryable = status === 429 || status === 529 || status >= 500;
    return new ProxyError(message, status, retryable, 'anthropic');
  }

  private mapStopReason(reason: string | null | undefined): StopReason {
    switch (reason) {
      case 'end_turn':
        return 'end';
      case 'max_tokens':
        return 'max_tokens';
      case 'tool_use':
        return 'tool_use';
      case 'stop_sequence':
        return 'end';
      default:
        return 'end';
    }
  }
}
