export interface ProxyClientOptions {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
}

/**
 * Provider identifiers usable in {@link ProviderPreferences}. This is a
 * deliberate standalone mirror of `PROVIDERS` in `@routeshift/shared` (the SDK
 * stays dependency-free for publishing). Keep it in sync with that list — the
 * SDK test `provider-name.test.ts` fails if the two ever diverge.
 */
export const SDK_PROVIDER_NAMES = [
  'openai',
  'anthropic',
  'google',
  'together',
  'groq',
  'zai',
  'cloudflare-workers-ai',
  'neuralwatt',
  'xiaomi',
  'minimax',
  'moonshot',
  'qwen',
  'azure',
  'bedrock',
  'xai',
  'deepseek',
  'mistral',
  'meta',
] as const;

export type ProviderName = (typeof SDK_PROVIDER_NAMES)[number];

export type ProviderSortPreference = 'price' | 'throughput';
export type DataCollectionPreference = 'allow' | 'deny';

export interface ProviderPreferences {
  order?: ProviderName[];
  allow?: ProviderName[];
  deny?: ProviderName[];
  data_collection?: DataCollectionPreference;
  sort?: ProviderSortPreference;
  allow_fallbacks?: boolean;
}

/** Plugin identifiers supported by the RouteShift proxy. */
export type PluginId = 'web' | 'file-parser';

/**
 * Optional request augmentation owned and executed by the proxy. The SDK
 * intentionally mirrors this small wire shape instead of taking a runtime
 * dependency on the proxy or shared packages.
 */
export interface PluginSpec {
  id: PluginId;
  required?: boolean;
  max_results?: number;
  search_prompt?: string;
}

/**
 * A non-fatal plugin outcome returned in a non-streaming completion body.
 * `code` remains a string so newer proxy warning codes do not make older SDKs
 * reject an otherwise valid response.
 */
export interface PluginWarning {
  plugin: PluginId;
  code: string;
  reason: string;
  message: string;
}

/** RouteShift metadata appended to a completion when optional plugins degrade. */
export interface PluginWarningResponseMetadata {
  warnings?: PluginWarning[];
}

export interface ChatCompletionRequest {
  /** A model may include RouteShift suffixes such as `:online`, `:floor`, or `:nitro`. */
  model?: string;
  /** Explicit ordered fallback chain. First entry is the primary model. */
  models?: string[];
  /** Server-side preset reference. A preset can supply the model when no model is sent. */
  preset?: string;
  /** OpenRouter-compatible per-request provider routing preferences. */
  provider?: ProviderPreferences;
  /** RouteShift preset/provider defaults use this field; `provider` is preferred for new SDK calls. */
  provider_preferences?: ProviderPreferences;
  /** Optional proxy-owned request augmentation. */
  plugins?: PluginSpec[];
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** Null on a pure tool-call assistant turn. */
    content: string | null;
    /** Tool calls made on an assistant turn (OpenAI shape). */
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
      /** Provider history required to replay some non-OpenAI tool turns. */
      extra_content?: { google?: { thought_signature?: string } };
    }>;
    /** Required on a role:'tool' result message — links it to the assistant tool call. */
    tool_call_id?: string;
  }>;
  /** Function/tool definitions the model may call (OpenAI shape). */
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: object } }>;
  /** Permit or force tool use. */
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  routeshift?: {
    max_retries?: number;
    max_cost_microcents?: number;
  };
}

/**
 * SDK-attached, non-enumerable RouteShift metadata from `X-RouteShift-Request-Id`.
 * This id, not the upstream completion `id`, is what `generation.get()` expects.
 */
export interface RouteShiftRequestMetadata {
  readonly _routeshift_request_id?: string;
}

/**
 * The proxy normalizes every non-streaming response to this OpenAI
 * chat-completion shape regardless of which provider served the request, so
 * this type is accurate for all routes. `content` is null when the assistant
 * turn is purely tool calls. For non-OpenAI providers the untouched upstream
 * body is available under `raw`; for OpenAI-native providers the response is the
 * provider's own body (so extra native fields may be present and `raw` absent).
 */
export interface ChatCompletionResponse extends RouteShiftRequestMetadata, PluginWarningResponseMetadata {
  id: string;
  object?: string;
  created?: number;
  model?: string;
  choices: Array<{
    index?: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
        /** Echo this field unchanged when submitting the assistant turn back. */
        extra_content?: { google?: { thought_signature?: string } };
      }>;
    };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Untouched upstream body, present when the request was served by a non-OpenAI provider. */
  raw?: unknown;
}

/**
 * RouteShift response metadata available once an SSE response starts. Plugin
 * warning values are the proxy's raw headers because stream bodies do not
 * carry a JSON `warnings` envelope.
 */
export interface ChatCompletionStreamMetadata extends RouteShiftRequestMetadata {
  /** Raw `X-RouteShift-Plugin-Warning` header (comma-separated warning codes). */
  pluginWarning?: string;
  /** Raw `X-RouteShift-Plugin-Skip-Reason` header with the proxy's exact reasons. */
  pluginSkipReason?: string;
}

export interface StreamEvent extends RouteShiftRequestMetadata {
  type: string;
  content?: string;
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
  tool_call?: {
    id: string;
    name: string;
    arguments_delta: string;
    index?: number;
    extra_content?: { google?: { thought_signature?: string } };
  };
}

/** An SSE iterator with RouteShift response metadata once the connection begins. */
export interface ChatCompletionStream extends AsyncGenerator<StreamEvent> {
  readonly metadata: Promise<ChatCompletionStreamMetadata>;
}

// ── Track A: models ──────────────────────────────────────────────────────────

export interface ModelEndpoint {
  provider: string;
  api_model_id: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
  data_policy: { zdr: boolean };
}

export interface Model {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  name: string;
  context_length: number;
  /** USD per token, as decimal strings (OpenRouter convention). */
  pricing: { prompt: string; completion: string };
  endpoints: ModelEndpoint[];
}

export interface ModelList {
  object: 'list';
  data: Model[];
}

// ── Track A: generation ──────────────────────────────────────────────────────

/** Inner payload of `GET /api/v1/generation` — the proxy wraps this in `{ data }`. */
export interface Generation {
  id: string;
  model: string;
  provider_name: string;
  created_at: string;
  streamed: boolean;
  cancelled: boolean | null;
  tokens_prompt: number;
  tokens_completion: number;
  /** Total cost in USD (includes any plugin surcharge). */
  total_cost: number;
  cache_discount: number | null;
  latency: number;
  generation_time: number;
}

/** Raw envelope returned by the proxy; `generation.get()` unwraps `.data`. */
export interface GenerationResponse {
  data: Generation;
}

// ── Track A: embeddings ──────────────────────────────────────────────────────

/**
 * The proxy forwards `encoding_format`, `dimensions`, and `user` when the
 * selected provider supports them; provider support varies.
 */
export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

export interface Embedding {
  object: 'embedding';
  /** `number[]` for float embeddings; `string` when `encoding_format: 'base64'`. */
  embedding: number[] | string;
  index: number;
}

export interface EmbeddingResponse {
  object: 'list';
  data: Embedding[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}
