import { PROVIDERS } from '@routeshift/shared';

/**
 * Single source of truth for the dashboard's provider allowlist: the shared
 * catalog's PROVIDERS tuple. Exported WITHOUT a widening annotation so the
 * literal tuple type (`'openai' | 'anthropic' | …`) survives for any future
 * type-level consumer — use isValidProvider() for runtime string checks, since
 * `.includes(string)` does not typecheck against a literal tuple.
 */
export const VALID_PROVIDERS = PROVIDERS;

/** Runtime membership check for an arbitrary (untyped) provider string. */
export function isValidProvider(provider: string): boolean {
  return (VALID_PROVIDERS as readonly string[]).includes(provider);
}

const SENSITIVE_METADATA_KEY_PATTERNS = [
  /api[_-]?key/i,
  /authorization/i,
  /bearer/i,
  /client[_-]?secret/i,
  /credentials?/i,
  /creds?/i,
  /password/i,
  /private[_-]?key/i,
  /secret/i,
  /session[_-]?token/i,
  /token/i,
];

const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_DEPTH_ERROR = `metadata nesting must not exceed ${MAX_METADATA_DEPTH} levels`;

export function validateProviderMetadata(provider: string, metadata: Record<string, unknown>): string | null {
  const sensitivePath = findSensitiveMetadataPath(metadata);
  if (sensitivePath === '__too_deep__') return MAX_METADATA_DEPTH_ERROR;
  if (sensitivePath) {
    return `metadata.${sensitivePath} must not contain credentials; put provider secrets in the encrypted key field`;
  }

  if (provider === 'azure') {
    const endpointUrl = typeof metadata.endpoint_url === 'string' ? metadata.endpoint_url.trim() : '';
    const resourceName = typeof metadata.resource_name === 'string' ? metadata.resource_name.trim() : '';
    const apiVersion = typeof metadata.api_version === 'string' ? metadata.api_version.trim() : '';
    if (endpointUrl) return validateAzureEndpointUrl(endpointUrl);
    if (resourceName && apiVersion) return validateAzureResourceName(resourceName);
    return "Provider 'azure' requires either metadata.endpoint_url or metadata.resource_name plus metadata.api_version";
  }

  if (provider === 'bedrock') {
    const accessKeyId = typeof metadata.access_key_id === 'string' ? metadata.access_key_id.trim() : '';
    const region = typeof metadata.region === 'string' ? metadata.region.trim() : '';
    if (!accessKeyId || !region) {
      return "Provider 'bedrock' requires metadata.access_key_id and metadata.region";
    }
    return validateAwsRegion(region);
  }

  if (provider === 'cloudflare-workers-ai') {
    const accountId = typeof metadata.account_id === 'string' ? metadata.account_id.trim() : '';
    if (!/^[0-9a-f]{32}$/.test(accountId)) {
      return "Provider 'cloudflare-workers-ai' requires metadata.account_id as a lowercase 32-character hexadecimal account ID";
    }
  }

  return null;
}

export function redactProviderMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return redactMetadataObject(metadata, 0);
}

function redactMetadataValue(value: unknown, depth: number): unknown {
  if (depth > MAX_METADATA_DEPTH) return '[redacted]';
  if (Array.isArray(value)) {
    return value.map((entry) => redactMetadataValue(entry, depth + 1));
  }
  if (isPlainObject(value)) {
    return redactMetadataObject(value, depth);
  }
  return value;
}

function redactMetadataObject(metadata: Record<string, unknown>, depth: number): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    redacted[key] = isSensitiveMetadataKey(key) ? '[redacted]' : redactMetadataValue(value, depth + 1);
  }
  return redacted;
}

function findSensitiveMetadataPath(value: unknown, path = '', depth = 0): string | null {
  if (depth > MAX_METADATA_DEPTH) return '__too_deep__';
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const match = findSensitiveMetadataPath(value[i], `${path}[${i}]`, depth + 1);
      if (match) return match;
    }
    return null;
  }
  if (!isPlainObject(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isSensitiveMetadataKey(key)) return childPath;
    const match = findSensitiveMetadataPath(child, childPath, depth + 1);
    if (match) return match;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSensitiveMetadataKey(key: string): boolean {
  return SENSITIVE_METADATA_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function validateAzureEndpointUrl(endpointUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    return 'Azure endpoint_url must be a valid URL';
  }
  const hostname = parsed.hostname.toLowerCase();
  const isAzureHost = hostname.endsWith('.openai.azure.com') || hostname.endsWith('.cognitiveservices.azure.com');
  if (parsed.protocol !== 'https:' || !isAzureHost || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return 'Azure endpoint_url must be an HTTPS Azure OpenAI endpoint with no credentials, query, or fragment';
  }
  const path = parsed.pathname.replace(/\/$/, '') || '/';
  if (path !== '/' && path !== '/openai/v1' && path !== '/openai/v1/chat/completions') {
    return 'Azure endpoint_url path must be empty, /openai/v1, or /openai/v1/chat/completions';
  }
  return null;
}

function validateAzureResourceName(resourceName: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(resourceName)) {
    return 'Azure resource_name must be a single Azure resource label that starts and ends with a letter or number';
  }
  return null;
}

function validateAwsRegion(region: string): string | null {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) {
    return 'Bedrock region must be a valid AWS region identifier';
  }
  return null;
}
