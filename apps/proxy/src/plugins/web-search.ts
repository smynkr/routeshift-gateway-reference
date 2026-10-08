import type { CanonicalContentPart, CanonicalRequest } from '@routeshift/shared';
import { createSearchBackend } from './search-backends/index.js';
import type { SearchResult } from './search-backends/index.js';
import type { PluginSpec } from './specs.js';

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TITLE_CODEPOINTS = 240;
const MAX_SNIPPET_CODEPOINTS = 1_500;
const MAX_URL_CODEPOINTS = 2_048;

/** These codes are intentionally stable: plugin outcomes and response headers
 * may expose them, but never backend content. */
export type WebSearchPolicyReason =
  | 'web_search_result_schema_invalid'
  | 'web_search_result_control_character'
  | 'web_search_result_title_too_long'
  | 'web_search_result_snippet_too_long'
  | 'web_search_result_url_too_long'
  | 'web_search_result_url_invalid'
  | 'web_search_result_limit_exceeded';

export class WebSearchPolicyError extends Error {
  constructor(readonly code: WebSearchPolicyReason) {
    super(code);
    this.name = 'WebSearchPolicyError';
  }
}

export async function augmentWithWebSearch(
  canonical: CanonicalRequest,
  spec: PluginSpec,
): Promise<CanonicalRequest> {
  const query = spec.search_prompt?.trim() || lastUserText(canonical);
  if (!query) throw new Error('No search query found');

  const maxResults = Math.min(spec.max_results ?? DEFAULT_MAX_RESULTS, MAX_RESULTS);
  const timeoutMs = positiveInt(process.env.PLUGIN_FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const results = await createSearchBackend().search(query, { maxResults, timeoutMs });
  if (results.length === 0) return canonical;

  const envelope = buildUntrustedWebSearchEnvelope(results);
  return {
    ...canonical,
    // Search data is attacker-controlled. It must never share the privileged
    // system/developer channel, even when labeled as "untrusted" text.
    messages: [...canonical.messages, {
      role: 'user',
      content: envelope,
    }],
  };
}

/**
 * Produces a data-only envelope for the non-privileged user channel. JSON
 * serialization prevents a result from changing the surrounding envelope;
 * runtime validation is still required because search backends are external.
 */
export function buildUntrustedWebSearchEnvelope(results: readonly unknown[]): string {
  if (results.length > MAX_RESULTS) throw new WebSearchPolicyError('web_search_result_limit_exceeded');
  const validated = results.map(validateSearchResult);
  return JSON.stringify({
    type: 'untrusted_web_search_results',
    version: 1,
    results: validated,
  });
}

function validateSearchResult(raw: unknown): SearchResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebSearchPolicyError('web_search_result_schema_invalid');
  }
  const result = raw as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => key !== 'title' && key !== 'url' && key !== 'snippet')
    || typeof result.title !== 'string'
    || typeof result.url !== 'string'
    || typeof result.snippet !== 'string'
  ) {
    throw new WebSearchPolicyError('web_search_result_schema_invalid');
  }

  const title = validateText(result.title, MAX_TITLE_CODEPOINTS, 'web_search_result_title_too_long');
  const snippet = validateText(result.snippet, MAX_SNIPPET_CODEPOINTS, 'web_search_result_snippet_too_long');
  const url = validateText(result.url, MAX_URL_CODEPOINTS, 'web_search_result_url_too_long');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebSearchPolicyError('web_search_result_url_invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new WebSearchPolicyError('web_search_result_url_invalid');
  }
  return { title, snippet, url: parsed.toString() };
}

function validateText(
  value: string,
  maxCodepoints: number,
  tooLongCode: Extract<WebSearchPolicyReason, `${string}_too_long`>,
): string {
  const normalized = value.normalize('NFC');
  if (hasControlCharacter(normalized)) throw new WebSearchPolicyError('web_search_result_control_character');
  if (Array.from(normalized).length > maxCodepoints) throw new WebSearchPolicyError(tooLongCode);
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  // Reject C0/C1 controls, including bidi/control-format characters, rather
  // than allowing attacker text to hide or visually reorder envelope fields.
  return /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/u.test(value);
}

function lastUserText(canonical: CanonicalRequest): string {
  for (let index = canonical.messages.length - 1; index >= 0; index -= 1) {
    const message = canonical.messages[index];
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content.trim();
    const text = message.content
      .filter(isTextContentPart)
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (text) return text;
  }
  return '';
}

function isTextContentPart(part: CanonicalContentPart): part is Extract<CanonicalContentPart, { type: 'text' }> {
  return part.type === 'text' && typeof part.text === 'string';
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
