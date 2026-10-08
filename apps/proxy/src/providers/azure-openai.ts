import type { CanonicalRequest } from '@routeshift/shared';
import { OpenAIProvider } from './openai.js';
import type { ProviderRequest } from './types.js';
import { validateHostInterpolation, buildSafeUpstreamUrl } from './url-helpers.js';

/**
 * Azure OpenAI provider. Wraps OpenAIProvider with three Azure-specific tweaks:
 *
 * 1. URL is either the classic deployment path
 *    `https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=<v>`
 *    or the newer OpenAI-compatible `/openai/v1/chat/completions` path when
 *    `endpoint_url` is provided in provider-key metadata.
 *    The deployment name defaults to the canonical request's `model` field, but
 *    metadata.deployment_name can override it for Azure deployments whose API
 *    name differs from the RouteShift canonical model name (for example
 *    canonical `gpt-5.5` backed by deployment `gpt55`).
 * 2. Auth header is `api-key: <key>` (NOT `Authorization: Bearer`).
 * 3. `resource_name` and `api_version` come from the metadata blob saved on the
 *    provider key (see migration 012-provider-keys-metadata.sql).
 *
 * If the metadata fields are missing the request is rejected up front rather than
 * sent and 404'd from Azure — easier to debug.
 */
export class AzureOpenAIProvider extends OpenAIProvider {
  constructor() {
    super();
    Object.defineProperty(this, 'id', { value: 'azure', writable: false });
  }

  override buildRequest(
    req: CanonicalRequest,
    apiKey: string,
    metadata?: Record<string, unknown>,
  ): ProviderRequest {
    const resource = typeof metadata?.resource_name === 'string' ? metadata.resource_name : null;
    const endpointUrl = typeof metadata?.endpoint_url === 'string' ? metadata.endpoint_url.trim() : null;
    const apiVersion = typeof metadata?.api_version === 'string' ? metadata.api_version : null;
    const deployment = typeof metadata?.deployment_name === 'string' && metadata.deployment_name.trim()
      ? metadata.deployment_name.trim()
      : req.model;
    if ((!resource && !endpointUrl) || (!endpointUrl && !apiVersion)) {
      throw new Error(
        'Azure provider requires either endpoint_url or resource_name plus api_version. Save them via the dashboard provider-keys flow.',
      );
    }
    // Guard the classic-deployment path: `resource` is interpolated raw into the
    // upstream host below. Without this, a metadata value like `evil.com#` would
    // redirect the request (and the team's Azure api-key) to an attacker host.
    // Azure resource names are alphanumeric + hyphen only. Mirrors the strict
    // validation buildV1Url() already applies to endpoint_url.
    if (!endpointUrl && resource !== null) {
      validateHostInterpolation(resource, /^[a-zA-Z0-9-]+$/, 'Azure resource_name must contain only letters, digits, and hyphens');
    }

    const baseReq = super.buildRequest(req, apiKey);
    const body = JSON.parse(baseReq.body) as Record<string, unknown>;
    body.model = deployment;
    baseReq.body = JSON.stringify(body);

    const url = endpointUrl
      ? buildV1Url(endpointUrl)
      : `https://${resource}.openai.azure.com/openai/deployments/${encodeURIComponent(deployment)}` +
        `/chat/completions?api-version=${encodeURIComponent(apiVersion!)}`;

    delete baseReq.headers['Authorization'];
    baseReq.headers['api-key'] = apiKey;

    return { ...baseReq, url };
  }
}

function buildV1Url(endpointUrl: string): string {
  const parsed = buildSafeUpstreamUrl(
    endpointUrl,
    ['.openai.azure.com', '.cognitiveservices.azure.com'],
    'Azure endpoint_url must be an HTTPS Azure OpenAI endpoint with no credentials, query, or fragment'
  );

  const base = parsed.toString().replace(/\/$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/openai/v1')) return `${base}/chat/completions`;
  if (parsed.pathname === '/' || parsed.pathname === '') return `${base}/openai/v1/chat/completions`;
  throw new Error('Azure endpoint_url path must be empty, /openai/v1, or /openai/v1/chat/completions');
}
