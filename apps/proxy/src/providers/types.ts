import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamChunk,
  TokenUsage,
  ProxyError,
  ProviderOutcomeSignals,
} from '@routeshift/shared';
import type { SSEEvent } from '../streaming/sse-parser.js';

export interface ProviderRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface EmbeddingOptions {
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

export interface LLMProvider {
  readonly id: string;
  /**
   * `metadata` carries non-secret structured config (e.g. Azure's
   * resource_name/api_version, Bedrock's region) loaded from
   * provider_keys.metadata. Optional — most providers ignore it.
   */
  buildRequest(
    req: CanonicalRequest,
    apiKey: string,
    metadata?: Record<string, unknown>,
  ): ProviderRequest;
  parseResponse(body: unknown): CanonicalResponse;
  /** Lossless per-attempt provider signals beside the canonical response, for the
   *  RSH-72 quality gate. Unknown raw outcomes stay exact (never mapped to 'end').
   *  Optional: a provider that doesn't supply it can't be quality-gated (fail-loud). */
  parseOutcomeSignals?(body: unknown): ProviderOutcomeSignals;
  // May return more than one canonical chunk for a single SSE event — e.g. when a
  // provider bundles the final content delta together with its finish/usage chunk.
  parseStreamChunk(event: SSEEvent): CanonicalStreamChunk | CanonicalStreamChunk[] | null;
  extractUsage(chunks: CanonicalStreamChunk[]): TokenUsage;
  normalizeError(status: number, body: unknown): ProxyError;

  // Optional embeddings support — providers without these members still satisfy the interface.
  supportsEmbeddings?: boolean;
  buildEmbeddingRequest?(input: string | string[], model: string, apiKey: string, opts?: EmbeddingOptions): ProviderRequest;
  parseEmbeddingResponse?(body: unknown): { embeddings: number[][]; usage: TokenUsage };
}
