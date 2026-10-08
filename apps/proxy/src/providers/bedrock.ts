import aws4 from 'aws4';
import type { CanonicalRequest } from '@routeshift/shared';
import { AnthropicProvider } from './anthropic.js';
import type { ProviderRequest } from './types.js';
import { validateHostInterpolation } from './url-helpers.js';

/**
 * Amazon Bedrock provider — v1 scope: Anthropic Claude models only,
 * non-streaming. Reuses AnthropicProvider's body shaping (Anthropic
 * Messages API), then strips/rewrites a couple fields and signs the
 * request with AWS Sigv4.
 *
 * Streaming is NOT supported in v1 — Bedrock's streaming endpoint
 * (`/invoke-with-response-stream`) returns AWS event-stream binary,
 * not SSE, which needs a separate parser. Tracked as a follow-up.
 *
 * Other Bedrock model families (Llama, Titan, Mistral, Cohere) have
 * different body schemas — also follow-up.
 *
 * Config:
 * - Provider key (encrypted_key): AWS secret_access_key
 * - Provider metadata: { access_key_id, region }
 *   Optional: session_token (for temporary STS creds — not yet wired)
 *
 * Routing:
 * - User creates a routing rule mapping a logical model (e.g. claude-sonnet-4-6)
 *   to provider=bedrock with the Bedrock model id as the override
 *   (e.g. anthropic.claude-sonnet-4-6-20260101-v1:0).
 */
export class BedrockProvider extends AnthropicProvider {
  constructor() {
    // baseUrl is unused for Bedrock — we build the host per-request from
    // metadata.region. Pass a placeholder so AnthropicProvider's constructor
    // is satisfied.
    super('https://bedrock-runtime.placeholder.amazonaws.com');
    Object.defineProperty(this, 'id', { value: 'bedrock', writable: false });
  }

  override buildRequest(
    req: CanonicalRequest,
    apiKey: string,
    metadata?: Record<string, unknown>,
  ): ProviderRequest {
    const accessKeyId = typeof metadata?.access_key_id === 'string' ? metadata.access_key_id : null;
    const region = typeof metadata?.region === 'string' ? metadata.region : null;
    const sessionToken = typeof metadata?.session_token === 'string' ? metadata.session_token : undefined;
    if (!accessKeyId || !region) {
      throw new Error(
        'Bedrock provider requires access_key_id and region in metadata. Save them via the dashboard provider-keys flow.',
      );
    }
    // Defense-in-depth: region is interpolated into the upstream host below, so
    // reject anything that isn't a well-formed AWS region. The dashboard already
    // validates on save, but the proxy must not trust stored data (SSRF guard).
    validateHostInterpolation(region, /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/, `Bedrock metadata.region "${region}" is not a valid AWS region.`);

    if (req.stream) {
      throw new Error(
        'Bedrock streaming not yet supported. Set stream:false or use a non-Bedrock provider for streaming.',
      );
    }

    // Build Anthropic-shaped body, then adjust for Bedrock.
    const baseReq = super.buildRequest(req, apiKey);
    const body = JSON.parse(baseReq.body);
    delete body.model; // Bedrock takes model in the URL path
    delete body.stream; // see early-return above
    body.anthropic_version = 'bedrock-2023-05-31';
    const bodyStr = JSON.stringify(body);

    const host = `bedrock-runtime.${region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(req.model)}/invoke`;

    const signed = aws4.sign(
      {
        service: 'bedrock',
        region,
        method: 'POST',
        host,
        path,
        headers: {
          'Content-Type': 'application/json',
        },
        body: bodyStr,
      },
      {
        accessKeyId,
        secretAccessKey: apiKey,
        ...(sessionToken ? { sessionToken } : {}),
      },
    );

    // aws4 signs Content-Length into the canonical headers, but Node's undici-
    // based fetch recomputes it — the mismatch produces SignatureDoesNotMatch
    // 403s. Strip it; fetch will set the right value before sending.
    const headers = { ...(signed.headers ?? {}) } as Record<string, string>;
    delete headers['Content-Length'];

    return {
      url: `https://${host}${path}`,
      method: 'POST',
      headers,
      body: bodyStr,
    };
  }
}
