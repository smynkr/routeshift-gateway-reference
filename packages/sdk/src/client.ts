import type {
  ProxyClientOptions,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStream,
  ChatCompletionStreamMetadata,
  StreamEvent,
  ModelList,
  Model,
  Generation,
  GenerationResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  RouteShiftRequestMetadata,
} from './types';
import { ProxyAPIError, ProxyRateLimitError, errorMessageFromBody } from './errors';

export class ProxyClient {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel?: string;

  /** Namespace for model-listing endpoints (`GET /v1/models`, `GET /v1/models/:id`). */
  readonly models: {
    list: () => Promise<ModelList>;
    get: (id: string) => Promise<Model>;
  };

  /** Namespace for generation metadata (`GET /api/v1/generation?id=<id>`). */
  readonly generation: {
    get: (id: string) => Promise<Generation>;
  };

  /** Namespace for embeddings (`POST /v1/embeddings`). */
  readonly embeddings: {
    create: (params: EmbeddingRequest) => Promise<EmbeddingResponse>;
  };

  constructor(options: ProxyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.defaultModel = options.defaultModel;

    this.models = {
      list: () => this.rawGet<ModelList>('/v1/models'),
      get: (id: string) => this.rawGet<Model>(`/v1/models/${encodeURIComponent(id)}`),
    };

    this.generation = {
      // The proxy returns { data: {...} }; unwrap so callers get the Generation
      // fields directly (otherwise generation.id would be undefined).
      get: async (id: string) => {
        const params = new URLSearchParams({ id });
        const res = await this.rawGet<GenerationResponse>(`/api/v1/generation?${params}`);
        return res.data;
      },
    };

    this.embeddings = {
      create: (params: EmbeddingRequest) => this.rawPost<EmbeddingResponse>('/v1/embeddings', params),
    };
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const response = await this.rawFetch('/v1/chat/completions', this.chatBody(request, false));
    const data = await this.parseJson<ChatCompletionResponse>(response);
    return this.attachRouteShiftRequestId(data, response);
  }

  chatStream(request: ChatCompletionRequest): ChatCompletionStream {
    let response: Promise<Response> | undefined;
    let metadata: Promise<ChatCompletionStreamMetadata> | undefined;
    const start = (): Promise<Response> => {
      response ??= Promise.resolve().then(() => (
        this.rawFetch('/v1/chat/completions', this.chatBody(request, true))
      ));
      return response;
    };
    const getMetadata = (): Promise<ChatCompletionStreamMetadata> => {
      metadata ??= start().then(
        (value) => this.streamMetadata(value),
        () => ({}),
      );
      return metadata;
    };
    const stream = this.readChatStream(start);
    // Keep normal stream creation lazy, but start the shared request if a
    // caller explicitly awaits response metadata before consuming events.
    Object.defineProperty(stream, 'metadata', { enumerable: true, get: getMetadata });
    return stream as ChatCompletionStream;
  }

  private async *readChatStream(start: () => Promise<Response>): AsyncGenerator<StreamEvent> {
    const response = await start();
    const requestId = this.getRouteShiftRequestId(response);
    if (!response.body) throw new ProxyAPIError('No response body for stream', 500);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') return;
          let event: StreamEvent;
          try {
            event = JSON.parse(data) as StreamEvent;
          } catch {
            // Skip malformed SSE lines (e.g. keep-alive comments / partials).
            continue;
          }
          // The proxy emits an in-band {type:'error'} chunk — with no [DONE]
          // sentinel — when the upstream stream fails mid-flight. Surface it as
          // a thrown error so consumers don't mistake a truncated stream for a
          // complete one. (Parsing is kept in its own try above so this throw
          // is not swallowed by the malformed-line handler.)
          if (event.type === 'error') {
            throw ProxyAPIError.fromResponse(502, {
              error: { message: 'Upstream stream error', stop_reason: event.stop_reason },
              _routeshift_request_id: requestId,
            });
          }
          yield this.attachRouteShiftRequestId(event, requestId);
        }
      }
    } finally {
      // cancel() tears down the underlying body stream / socket (and releases
      // the lock). Needed when the consumer breaks out of the for-await early or
      // we hit [DONE]; releaseLock() alone would leak the connection.
      await reader.cancel().catch(() => {});
    }
  }

  private async rawGet<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '0', 10);
        throw new ProxyRateLimitError(errorMessageFromBody(errorBody) ?? 'Rate limited', retryAfter || undefined);
      }
      throw ProxyAPIError.fromResponse(response.status, errorBody);
    }
    return this.parseJson<T>(response);
  }

  /**
   * Presets resolve their own default model in the proxy. Sending the SDK
   * default alongside a preset would turn that default into an explicit model
   * override, so only use it when no usable preset was requested.
   */
  private chatBody(request: ChatCompletionRequest, stream: boolean): ChatCompletionRequest {
    const hasPreset = typeof request.preset === 'string' && request.preset.length > 0;
    const model = request.model ?? request.models?.[0] ?? (hasPreset ? undefined : this.defaultModel);
    if (!model && !hasPreset) {
      throw new ProxyAPIError('model is required when no defaultModel is configured', 400);
    }
    return model === undefined
      ? { ...request, stream }
      : { ...request, model, stream };
  }

  /** Authenticated POST that returns parsed JSON (reuses rawFetch's error handling). */
  private async rawPost<T>(path: string, body: unknown): Promise<T> {
    const response = await this.rawFetch(path, body);
    return this.parseJson<T>(response);
  }

  /**
   * Parse a successful (2xx) response body as JSON, converting a malformed or
   * empty body into a typed ProxyAPIError instead of a raw SyntaxError — so an
   * intermediary returning a non-JSON 2xx (HTML error page, empty body) still
   * surfaces through the SDK's documented error model. Error (non-2xx) bodies
   * are parsed separately with their own tolerant `.catch(() => ({}))` guards.
   */
  private async parseJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T;
    } catch {
      throw new ProxyAPIError(
        `RouteShift returned a non-JSON ${response.status} response`,
        response.status,
      );
    }
  }

  private async rawFetch(path: string, body: unknown): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') ?? '0', 10);
        throw new ProxyRateLimitError(errorMessageFromBody(errorBody) ?? 'Rate limited', retryAfter || undefined);
      }
      throw ProxyAPIError.fromResponse(response.status, errorBody);
    }
    return response;
  }

  private getRouteShiftRequestId(response: Response): string | undefined {
    return response.headers?.get('x-routeshift-request-id') ?? undefined;
  }

  private streamMetadata(response: Response): ChatCompletionStreamMetadata {
    return {
      _routeshift_request_id: this.getRouteShiftRequestId(response),
      pluginWarning: response.headers?.get('x-routeshift-plugin-warning') ?? undefined,
      pluginSkipReason: response.headers?.get('x-routeshift-plugin-skip-reason') ?? undefined,
    };
  }

  private attachRouteShiftRequestId<T extends RouteShiftRequestMetadata>(
    value: T,
    responseOrRequestId: Response | string | undefined,
  ): T {
    const requestId = typeof responseOrRequestId === 'string'
      ? responseOrRequestId
      : responseOrRequestId ? this.getRouteShiftRequestId(responseOrRequestId) : undefined;

    if (!requestId || !value || typeof value !== 'object') return value;

    // Keep the OpenAI-compatible JSON shape enumerable while exposing the
    // RouteShift request id needed by generation.get().
    Object.defineProperty(value, '_routeshift_request_id', {
      value: requestId,
      enumerable: false,
      configurable: true,
    });
    return value;
  }
}
