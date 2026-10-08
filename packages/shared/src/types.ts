export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  /** A provider-neutral system string or preserved provider content blocks.
   * File-parser may replace a raw file block with a text block, but must not
   * flatten unrelated metadata such as Anthropic cache_control. */
  system_prompt?: CanonicalSystemPrompt;
  max_output_tokens?: number;
  temperature?: number;
  tools?: CanonicalTool[];
  tool_choice?: CanonicalToolChoice;
  response_format?: CanonicalResponseFormat;
  stream: boolean;
  provider_params?: CanonicalProviderParams;
  reasoning_effort?: 'low' | 'medium' | 'high';
  /** Gemini 3+ native reasoning control. Gemini 2.5 uses thinking_budget_tokens. */
  thinking_level?: 'minimal' | 'low' | 'medium' | 'high';
  thinking_budget_tokens?: number;
}

export type CanonicalSystemPrompt = string | Array<Record<string, unknown>>;

/** A response_format reaches canonical verbatim from the client, so this union
 *  models every real shape: the repo-internal `{type:'json'}` spelling and the
 *  OpenAI-compatible `json_object` / `json_schema` variants. A concrete schema
 *  may arrive under the legacy top-level `schema` (json) or OpenAI's nested
 *  `json_schema.schema` (json_schema). */
export type CanonicalResponseFormat =
  | { type: 'text' }
  | { type: 'json' | 'json_object'; schema?: object }
  | { type: 'json_schema'; json_schema?: { name?: string; schema?: object; strict?: boolean } };

export interface CanonicalProviderParams extends Record<string, unknown> {
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
  logit_bias?: Record<string, number>;
  logprobs?: boolean;
  top_logprobs?: number;
  n?: number;
}

export interface CanonicalMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | CanonicalContentPart[];
  /** Tool calls emitted on a prior assistant turn (OpenAI shape). Must be
   *  carried through to upstream so multi-turn tool loops keep their context. */
  tool_calls?: CanonicalToolCall[];
  /** Links a role:'tool' result message back to the assistant tool call that
   *  produced it. OpenAI rejects a tool message that lacks a matching id. */
  tool_call_id?: string;
}

export type CanonicalContentPart = CanonicalTextContentPart | CanonicalImageUrlContentPart | CanonicalPdfContentPart;

export interface CanonicalTextContentPart {
  type: 'text';
  text?: string;
}

export interface CanonicalImageUrlContentPart {
  type: 'image_url';
  image_url?: { url: string };
}

/**
 * A validated PDF payload. This is deliberately an internal canonical shape,
 * not the caller's OpenAI-compatible file part: URL inputs are fetched through
 * the proxy's SSRF guard and normalized to bounded base64 before reaching an
 * adapter. Only adapters with an explicit native-PDF implementation may emit
 * it upstream.
 */
export interface CanonicalPdfContentPart {
  type: 'pdf';
  pdf: {
    media_type: 'application/pdf';
    data: string;
    filename?: string;
  };
}

export interface CanonicalTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

export type CanonicalToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface CanonicalResponse {
  id: string;
  model: string;
  content: string;
  tool_calls?: CanonicalToolCall[];
  stop_reason: StopReason;
  usage: import('./token-usage').TokenUsage;
}

export interface CanonicalToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Opaque provider history that must survive an OpenAI-compatible round trip.
   * Gemini 3 requires the exact thought signature on the original function-call
   * Part when the caller submits the following tool result. */
  extra_content?: {
    google?: { thought_signature?: string };
  };
}

export interface CanonicalStreamChunk {
  type: 'content_delta' | 'tool_call_delta' | 'usage' | 'error' | 'done';
  content?: string;
  // `index` identifies which tool call a delta belongs to within a single
  // streamed turn. Providers emit a tool's `id`/`name` only on its first delta;
  // continuation deltas (and parallel tool calls) carry just the index, so
  // consumers must group by index to reassemble each tool call correctly.
  tool_call?: {
    id: string;
    name: string;
    arguments_delta: string;
    index?: number;
    extra_content?: CanonicalToolCall['extra_content'];
  };
  usage?: import('./token-usage').TokenUsage;
  stop_reason?: StopReason;
}

export type StopReason = 'end' | 'max_tokens' | 'tool_use' | 'safety' | 'error';
