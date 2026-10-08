/**
 * Shared LiteLLM source helpers.
 *
 * Both `sync-pricing.ts` (refreshes the fallback pricing table) and
 * `detect-model-drift.ts` (surfaces newly-released / removed models) read the
 * same community-maintained LiteLLM catalog. Keep the fetch, the provider map,
 * and the prefix-stripping in ONE place so the two tools can never disagree
 * about which upstream provider maps to which RouteShift provider.
 *
 * These run at build/cron time only — never at request time.
 */

export const LITELLM_SOURCE =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// LiteLLM uses its own provider keys (`gemini`, `vertex_ai`, `together_ai`).
// Map them to the provider ids RouteShift actually proxies. Anything not in
// this map is skipped — RouteShift does not route it, so we do not track it.
export const LITELLM_PROVIDER_MAP: Record<string, string> = {
  openai: 'openai',
  azure: 'azure',
  anthropic: 'anthropic',
  gemini: 'google',
  vertex_ai: 'google',
  vertex_ai_beta: 'google',
  bedrock: 'bedrock',
  bedrock_converse: 'bedrock',
  groq: 'groq',
  together_ai: 'together',
  zai: 'zai',
  minimax: 'minimax',
  moonshot: 'moonshot',
  dashscope: 'qwen',
  xai: 'xai',
  deepseek: 'deepseek',
  mistral: 'mistral',
  meta_llama: 'meta',
  cohere: 'cohere',
};

export interface LiteLLMEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_272k_tokens?: number;
  output_cost_per_token_above_272k_tokens?: number;
  cache_read_input_token_cost_above_272k_tokens?: number;
  cache_creation_input_token_cost_above_272k_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
}

export interface LiteLLMRawCatalog {
  bytes: Uint8Array;
  text: string;
}

export const LITELLM_FETCH_TIMEOUT_MS = 30_000;
export const LITELLM_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface LiteLLMFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

function responseHeader(response: Response, name: string): string | null {
  const headers = (response as Response & { headers?: Headers }).headers;
  return headers && typeof headers.get === 'function' ? headers.get(name) : null;
}

function validateResponseHeaders(response: Response, maxBytes: number): void {
  const rawLength = responseHeader(response, 'content-length')?.trim() ?? '';
  if (rawLength !== '') {
    if (!/^\d+$/.test(rawLength)) {
      throw new Error(`LiteLLM JSON response has invalid Content-Length: ${rawLength}`);
    }
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      throw new Error(`LiteLLM JSON response exceeds maximum ${maxBytes} bytes`);
    }
  }

  const rawContentType = responseHeader(response, 'content-type')?.split(';', 1)[0].trim().toLowerCase();
  // raw.githubusercontent.com serves committed JSON as text/plain. It is
  // allowed only alongside the fixed, trusted source URL; arbitrary HTML/XML
  // responses are never parsed as catalog data.
  if (rawContentType !== 'application/json' && rawContentType !== 'text/plain') {
    throw new Error(
      `LiteLLM JSON response has unsupported content-type: ${rawContentType || 'missing'}`,
    );
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const body = (response as Response & { body?: ReadableStream<Uint8Array> | null }).body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error('LiteLLM JSON fetch timed out');
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`LiteLLM JSON response exceeds maximum ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  const fallback = response as Response & {
    arrayBuffer?: () => Promise<ArrayBuffer>;
    text?: () => Promise<string>;
  };
  if (typeof fallback.arrayBuffer === 'function') {
    const bytes = new Uint8Array(await fallback.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`LiteLLM JSON response exceeds maximum ${maxBytes} bytes`);
    }
    return bytes;
  }
  if (typeof fallback.text === 'function') {
    const text = await fallback.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`LiteLLM JSON response exceeds maximum ${maxBytes} bytes`);
    }
    return bytes;
  }
  throw new Error('LiteLLM JSON fetch returned no readable body');
}

async function fetchResponse(
  sourceUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  const origin = new URL(sourceUrl).origin;
  let url = sourceUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetchImpl(url, { signal, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = responseHeader(response, 'location');
    if (!location) throw new Error(`LiteLLM JSON redirect missing Location header (${response.status})`);
    const next = new URL(location, url);
    if (next.origin !== origin) {
      throw new Error(`LiteLLM JSON redirect rejected: cross-origin target ${next.origin}`);
    }
    url = next.toString();
  }
  throw new Error(`LiteLLM JSON redirect limit exceeded (${MAX_REDIRECTS})`);
}

/**
 * Fetch the upstream bytes once with bounded time, size, and redirects. The
 * refresh command hashes these exact bytes before parsing so provenance cannot
 * drift between the pricing and model generators.
 */
export async function fetchLiteLLMCatalogRaw(
  options: LiteLLMFetchOptions = {},
): Promise<LiteLLMRawCatalog> {
  const timeoutMs = options.timeoutMs ?? LITELLM_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? LITELLM_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`LiteLLM JSON fetch timeout must be positive: ${timeoutMs}`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`LiteLLM JSON response cap must be a positive safe integer: ${maxBytes}`);
  }

  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`LiteLLM JSON fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    const work = (async () => {
      const response = await fetchResponse(LITELLM_SOURCE, fetchImpl, controller.signal);
      if (!response.ok) {
        throw new Error(`LiteLLM JSON fetch failed: ${response.status} ${response.statusText}`);
      }
      validateResponseHeaders(response, maxBytes);
      const bytes = await readBoundedBody(response, maxBytes, controller.signal);
      return { bytes, text: new TextDecoder().decode(bytes) };
    })();
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (timedOut || controller.signal.aborted) {
      throw new Error(`LiteLLM JSON fetch timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/** Parse already-fetched LiteLLM bytes without performing another fetch. */
export function parseLiteLLMCatalog(raw: string | Uint8Array): Record<string, LiteLLMEntry> {
  const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LiteLLM JSON schema invalid: expected an object');
  }
  return parsed as Record<string, LiteLLMEntry>;
}

/** Existing convenience API: fetch once and parse once. */
export async function fetchLiteLLMCatalog(
  options: LiteLLMFetchOptions = {},
): Promise<Record<string, LiteLLMEntry>> {
  const { text } = await fetchLiteLLMCatalogRaw(options);
  return parseLiteLLMCatalog(text);
}

/**
 * LiteLLM keys some entries with a provider prefix (`groq/llama-3.3`,
 * `bedrock/anthropic.claude-3-5-sonnet`). Strip it so callers can look up by
 * the model id they actually send through the proxy.
 */
export function stripProviderPrefix(key: string): string {
  const slash = key.indexOf('/');
  if (slash === -1) return key;
  return key.slice(slash + 1);
}

/** RouteShift provider id for a LiteLLM entry, or null if we do not proxy it. */
export function mappedProvider(entry: LiteLLMEntry): string | null {
  return entry.litellm_provider ? LITELLM_PROVIDER_MAP[entry.litellm_provider] ?? null : null;
}
