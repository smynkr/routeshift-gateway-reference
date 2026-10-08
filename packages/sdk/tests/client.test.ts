import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProxyClient } from '../src/client';
import { ProxyAPIError, ProxyRateLimitError } from '../src/errors';

function createMockSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      }
      controller.close();
    },
  });
}

describe('ProxyClient', () => {
  const client = new ProxyClient({
    baseUrl: 'https://proxy.example.com',
    apiKey: 'sk-proxy-live_test_abc123',
    defaultModel: 'gpt-4.1',
  });

  beforeEach(() => { vi.restoreAllMocks(); });

  it('sends correct headers and URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ id: '1', choices: [], usage: {} }),
    });
    vi.stubGlobal('fetch', mockFetch);
    await client.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://proxy.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-proxy-live_test_abc123' },
      }),
    );
  });

  it('uses default model when not specified', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: '1', choices: [], usage: {} }) }));
    await client.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4.1');
    expect(body.stream).toBe(false);
  });

  it('allows model override', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: '1', choices: [], usage: {} }) }));
    await client.chat({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'Hi' }] });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.model).toBe('claude-haiku-4-5');
  });

  it('passes through routing fields for provider preferences and ordered fallback models', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: '1', choices: [], usage: {} }) }));

    await client.chat({
      model: 'gpt-5.5-pro:floor',
      models: ['gpt-5.5-pro:floor', 'claude-haiku-4-5'],
      provider: { allow: ['azure', 'anthropic'], sort: 'price', allow_fallbacks: true },
      routeshift: { max_retries: 1 },
      messages: [{ role: 'user', content: 'Hi' }],
    });

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.models).toEqual(['gpt-5.5-pro:floor', 'claude-haiku-4-5']);
    expect(body.provider).toEqual({ allow: ['azure', 'anthropic'], sort: 'price', allow_fallbacks: true });
    expect(body.routeshift).toEqual({ max_retries: 1 });
  });

  it('passes presets, plugins, and the :online suffix through exactly', async () => {
    const warnings = [{
      plugin: 'web',
      code: 'plugin_backend_not_configured',
      reason: 'No search backend is configured',
      message: 'Web search was skipped',
    }];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '1', choices: [], usage: {}, warnings }),
    }));

    const plugins = [
      { id: 'web' as const, required: true, max_results: 3, search_prompt: 'current pricing' },
      { id: 'file-parser' as const },
    ];
    const response = await client.chat({
      model: 'gpt-5.4:online',
      preset: 'research-assistant',
      plugins,
      messages: [{ role: 'user', content: 'What changed?' }],
    });

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.model).toBe('gpt-5.4:online');
    expect(body.preset).toBe('research-assistant');
    expect(body.plugins).toEqual(plugins);
    expect(response.warnings).toEqual(warnings);
  });

  it('allows a preset to supply the model when no SDK default is configured', async () => {
    const c = new ProxyClient({ baseUrl: 'https://proxy.example.com', apiKey: 'key' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: '1', choices: [], usage: {} }) }));

    await c.chat({ preset: 'support', messages: [{ role: 'user', content: 'Help' }] });

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ preset: 'support', stream: false });
    expect(body).not.toHaveProperty('model');
  });

  it('does not inject the SDK default alongside a preset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: '1', choices: [], usage: {} }) }));

    await client.chat({ preset: 'support', messages: [{ role: 'user', content: 'Help' }] });

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ preset: 'support', stream: false });
    expect(body).not.toHaveProperty('model');
  });

  it('still rejects before fetch when neither a model nor a preset is available', async () => {
    const c = new ProxyClient({ baseUrl: 'https://proxy.example.com', apiKey: 'key' });
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    await expect(c.chat({ messages: [{ role: 'user', content: 'Help' }] })).rejects.toThrow(
      'model is required when no defaultModel is configured',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses models[0] as the primary model when model is omitted', async () => {
    const c = new ProxyClient({ baseUrl: 'https://proxy.example.com', apiKey: 'key' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: '1', choices: [], usage: {} }) }));

    await c.chat({ models: ['gpt-5.4', 'claude-haiku-4-5'], messages: [{ role: 'user', content: 'Hi' }] });

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.model).toBe('gpt-5.4');
    expect(body.models).toEqual(['gpt-5.4', 'claude-haiku-4-5']);
  });

  it('throws ProxyAPIError on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: () => Promise.resolve({ error: { message: 'Invalid key' } }), headers: new Headers(),
    }));
    await expect(client.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow(ProxyAPIError);
    await expect(client.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow('Invalid key');
  });

  it('throws ProxyRateLimitError on 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: () => Promise.resolve({ error: { message: 'Rate limited' } }),
      headers: new Headers({ 'retry-after': '30' }),
    }));
    try {
      await client.chat({ messages: [{ role: 'user', content: 'Hi' }] });
    } catch (e) {
      expect(e).toBeInstanceOf(ProxyRateLimitError);
      expect((e as ProxyRateLimitError).retryAfter).toBe(30);
    }
  });

  it('wraps a 2xx non-JSON body in ProxyAPIError on chat()', async () => {
    // An intermediary (CDN/gateway) can return a 200 with an empty/HTML body;
    // response.json() then rejects with a raw SyntaxError. The SDK must surface
    // this through its documented error model, not leak a SyntaxError.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      headers: new Headers(),
    }));
    await expect(client.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow(ProxyAPIError);
  });

  it('wraps a 2xx non-JSON body in ProxyAPIError on GET endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token <')),
      headers: new Headers(),
    }));
    await expect(client.models.list()).rejects.toThrow(ProxyAPIError);
  });

  it('strips trailing slash from baseUrl', async () => {
    const c = new ProxyClient({ baseUrl: 'https://proxy.example.com/', apiKey: 'key' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }));
    await c.chat({ model: 'test', messages: [{ role: 'user', content: 'Hi' }] });
    expect((fetch as any).mock.calls[0][0]).toBe('https://proxy.example.com/v1/chat/completions');
  });

  describe('chatStream', () => {
    it('yields parsed events from mock SSE stream', async () => {
      const event1 = JSON.stringify({ type: 'content_block_delta', content: 'Hello' });
      const event2 = JSON.stringify({ type: 'content_block_delta', content: ' world' });
      const stream = createMockSSEStream([event1, event2, '[DONE]']);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      }));

      const events: unknown[] = [];
      for await (const event of client.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: 'content_block_delta', content: 'Hello' });
      expect(events[1]).toEqual({ type: 'content_block_delta', content: ' world' });
    });

    it('handles [DONE] sentinel -- stops iteration', async () => {
      const event1 = JSON.stringify({ type: 'content_block_delta', content: 'before' });
      const eventAfterDone = JSON.stringify({ type: 'content_block_delta', content: 'after' });
      const stream = createMockSSEStream([event1, '[DONE]', eventAfterDone]);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      }));

      const events: unknown[] = [];
      for await (const event of client.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      // Should only have the event before [DONE], not the one after
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'content_block_delta', content: 'before' });
    });

    it('handles null response body -- throws ProxyAPIError', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: null,
      }));

      const generator = client.chatStream({ messages: [{ role: 'user', content: 'Hi' }] });
      await expect(generator.next()).rejects.toThrow(ProxyAPIError);
      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of client.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
            // should not reach here
          }
        })(),
      ).rejects.toThrow('No response body for stream');
    });

    it('handles malformed JSON in stream -- skips silently', async () => {
      const validEvent = JSON.stringify({ type: 'content_block_delta', content: 'valid' });
      const stream = createMockSSEStream([
        'not-valid-json{{{',
        validEvent,
        '}{broken',
        '[DONE]',
      ]);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      }));

      const events: unknown[] = [];
      for await (const event of client.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        events.push(event);
      }

      // Only the valid JSON event should be yielded
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'content_block_delta', content: 'valid' });
    });

    it('throws when the stream emits an in-band error chunk (no [DONE])', async () => {
      const delta = JSON.stringify({ type: 'content_block_delta', content: 'partial' });
      const errorChunk = JSON.stringify({ type: 'error', stop_reason: 'error' });
      // No [DONE] — mirrors the proxy relay's mid-stream failure path, where the
      // upstream errors after headers are sent.
      const stream = createMockSSEStream([delta, errorChunk]);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      const events: unknown[] = [];
      await expect(
        (async () => {
          for await (const event of client.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
            events.push(event);
          }
        })(),
      ).rejects.toThrow(ProxyAPIError);

      // The delta before the error is still delivered; the error is surfaced as
      // a thrown error rather than silently yielded as a normal event (which
      // would look like a successful, complete — but truncated — response).
      expect(events).toEqual([{ type: 'content_block_delta', content: 'partial' }]);
    });

    it('cancels the reader in finally -- even on error (tears down the body/socket)', async () => {
      const cancelSpy = vi.fn().mockResolvedValue(undefined);
      const mockReader = {
        read: vi.fn()
          .mockResolvedValueOnce({
            done: false,
            value: new TextEncoder().encode(`data: ${JSON.stringify({ type: 'delta', content: 'x' })}\n\n`),
          })
          .mockRejectedValueOnce(new Error('stream broke')),
        // cancel() is the cleanup contract: it releases the lock AND tears down
        // the underlying body stream / socket, so an abandoned or errored stream
        // doesn't leak the connection.
        cancel: cancelSpy,
        releaseLock: vi.fn(),
      };

      const mockBody = { getReader: () => mockReader } as unknown as ReadableStream<Uint8Array>;

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: mockBody,
      }));

      const events: unknown[] = [];
      try {
        for await (const event of client.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
          events.push(event);
        }
      } catch {
        // expected to throw
      }

      // cleanup should always run via the finally block
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it('sets stream: true in the request body', async () => {
      const stream = createMockSSEStream(['[DONE]']);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: stream }));

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.chatStream({ messages: [{ role: 'user', content: 'Hi' }] })) {
        // consume
      }

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.stream).toBe(true);
    });

    it('allows preset-only streaming requests without adding a default model', async () => {
      const c = new ProxyClient({ baseUrl: 'https://proxy.example.com', apiKey: 'key', defaultModel: 'gpt-4.1' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body: createMockSSEStream(['[DONE]']) }));

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of c.chatStream({ preset: 'streaming-support', messages: [{ role: 'user', content: 'Hi' }] })) {
        // The sentinel ends the stream before an event is yielded.
      }

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body).toMatchObject({ preset: 'streaming-support', stream: true });
      expect(body).not.toHaveProperty('model');
    });

    it('surfaces plugin warning headers as stream metadata', async () => {
      const c = new ProxyClient({ baseUrl: 'https://proxy.example.com', apiKey: 'key' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        body: createMockSSEStream(['[DONE]']),
        headers: new Headers({
          'x-routeshift-request-id': 'req_stream_warning',
          'x-routeshift-plugin-warning': 'plugin_backend_not_configured,file_url_blocked',
          'x-routeshift-plugin-skip-reason': 'Web search was skipped | File URL was blocked',
        }),
      }));

      const stream = c.chatStream({
        model: 'gpt-5.4:online',
        plugins: [{ id: 'web' }],
        messages: [{ role: 'user', content: 'Hi' }],
      });
      const metadata = await stream.metadata;
      expect(metadata).toEqual({
        _routeshift_request_id: 'req_stream_warning',
        pluginWarning: 'plugin_backend_not_configured,file_url_blocked',
        pluginSkipReason: 'Web search was skipped | File URL was blocked',
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of stream) {
        // The sentinel ends the stream before an event is yielded.
      }
    });

    it('resolves empty stream metadata when the response fails before headers arrive', async () => {
      const c = new ProxyClient({ baseUrl: 'https://proxy.example.com', apiKey: 'key' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: { message: 'Unavailable' } }),
        headers: new Headers(),
      }));

      const stream = c.chatStream({ model: 'gpt-5.4', messages: [{ role: 'user', content: 'Hi' }] });
      await expect(stream.metadata).resolves.toEqual({});
      await expect(stream.next()).rejects.toThrow('Unavailable');
    });
  });
});
