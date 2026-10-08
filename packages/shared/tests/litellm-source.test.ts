import { describe, expect, it, vi } from 'vitest';
import {
  fetchLiteLLMCatalogRaw,
  LITELLM_MAX_RESPONSE_BYTES,
} from '../scripts/litellm-source.js';

function response(
  body: Uint8Array,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      ...headers,
    },
  });
}

describe('fetchLiteLLMCatalogRaw', () => {
  it('rejects a response with a non-JSON content type before reading its body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/html' }),
      body: { getReader: () => { throw new Error('body should not be read'); } },
    });

    await expect(fetchLiteLLMCatalogRaw({ fetchImpl })).rejects.toThrow(/content-type/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects Content-Length values above the hard response cap', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(LITELLM_MAX_RESPONSE_BYTES + 1),
      }),
      body: null,
    });

    await expect(fetchLiteLLMCatalogRaw({ fetchImpl })).rejects.toThrow(/maximum|byte|size/i);
  });

  it('enforces the cap while streaming a chunked response without Content-Length', async () => {
    const tooLarge = new Uint8Array(LITELLM_MAX_RESPONSE_BYTES + 1);
    const fetchImpl = vi.fn().mockResolvedValue(response(tooLarge, {
      'content-length': '',
    }));

    await expect(fetchLiteLLMCatalogRaw({ fetchImpl })).rejects.toThrow(/maximum|byte|size/i);
  });

  it('aborts and reports a timeout while the source request is still pending', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));

    await expect(fetchLiteLLMCatalogRaw({ fetchImpl, timeoutMs: 1 })).rejects.toThrow(/timed out|timeout/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows same-origin redirects but rejects cross-origin redirects', async () => {
    const bytes = new TextEncoder().encode('{}');
    const sameOriginFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: '/catalog.json' },
      }))
      .mockResolvedValueOnce(response(bytes));

    await expect(fetchLiteLLMCatalogRaw({ fetchImpl: sameOriginFetch })).resolves.toMatchObject({ text: '{}' });
    expect(sameOriginFetch).toHaveBeenCalledTimes(2);
    expect(sameOriginFetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });

    const crossOriginFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'https://example.invalid/catalog.json' },
    }));
    await expect(fetchLiteLLMCatalogRaw({ fetchImpl: crossOriginFetch })).rejects.toThrow(/cross-origin|redirect/i);
    expect(crossOriginFetch).toHaveBeenCalledTimes(1);
  });
});
