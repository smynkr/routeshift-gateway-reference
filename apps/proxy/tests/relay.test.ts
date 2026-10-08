import { describe, it, expect, vi, beforeEach } from 'vitest';
import { relayStream } from '../src/streaming/relay.js';
import type { LLMProvider } from '../src/providers/types.js';
import type { ServerResponse } from 'node:http';

function createMockClientResponse() {
  const written: string[] = [];
  const mock = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => { written.push(chunk); return true; }),
    end: vi.fn(),
    once: vi.fn(),
    // relay registers an abort listener on 'close' and removes it in finally.
    removeListener: vi.fn(),
    _written: written,
  };
  return mock as unknown as ServerResponse & { _written: string[] };
}

function createBackpressureClientResponse() {
  const written: string[] = [];
  let writeCalls = 0;
  const listeners = new Map<string, (() => void)[]>();

  const mock = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      writeCalls += 1;
      return writeCalls === 1 ? false : true;
    }),
    end: vi.fn(),
    once: vi.fn((event: string, cb: () => void) => {
      const current = listeners.get(event) ?? [];
      current.push(cb);
      listeners.set(event, current);
      return mock;
    }),
    removeListener: vi.fn((event: string, cb: () => void) => {
      const current = listeners.get(event) ?? [];
      listeners.set(event, current.filter((f) => f !== cb));
      return mock;
    }),
    emit(event: string) {
      const cbs = listeners.get(event) ?? [];
      for (const cb of cbs) cb();
      listeners.set(event, []);
    },
    _written: written,
  };

  return mock as unknown as ServerResponse & { _written: string[]; emit: (event: string) => void };
}

function createAbortableClientResponse() {
  const written: string[] = [];
  const listeners = new Map<string, (() => void)[]>();
  const mock = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => { written.push(chunk); return true; }),
    end: vi.fn(),
    destroyed: false,
    once: vi.fn((event: string, cb: () => void) => {
      const current = listeners.get(event) ?? [];
      current.push(cb);
      listeners.set(event, current);
      return mock;
    }),
    removeListener: vi.fn((event: string, cb: () => void) => {
      const current = listeners.get(event) ?? [];
      listeners.set(event, current.filter((f) => f !== cb));
      return mock;
    }),
    emit(event: string) {
      for (const cb of listeners.get(event) ?? []) cb();
    },
    _written: written,
  };
  return mock as unknown as ServerResponse & { _written: string[]; emit: (event: string) => void };
}

function createMockProvider(chunks: Array<{ type: string; [k: string]: unknown } | null> = []): LLMProvider {
  let idx = 0;
  return {
    id: 'test-provider',
    buildRequest: vi.fn(),
    parseResponse: vi.fn(),
    parseStreamChunk: vi.fn(() => {
      const c = chunks[idx] ?? null;
      idx++;
      return c;
    }),
    extractUsage: vi.fn(() => ({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })),
    normalizeError: vi.fn(() => ({ message: 'error', code: 'internal_error', status: 500 })),
  } as unknown as LLMProvider;
}

function createMockUpstreamResponse(chunks: Uint8Array[]): Response {
  let idx = 0;
  const mockReader = {
    read: vi.fn(async () => {
      if (idx >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: chunks[idx++] };
    }),
  };
  return {
    body: {
      getReader: () => mockReader,
    },
  } as unknown as Response;
}

describe('relayStream', () => {
  let clientRes: ReturnType<typeof createMockClientResponse>;

  beforeEach(() => {
    clientRes = createMockClientResponse();
  });

  it('successfully relays SSE chunks to client response', async () => {
    const encoder = new TextEncoder();
    const sseData = 'data: {"content":"hello"}\n\n';
    const upstream = createMockUpstreamResponse([encoder.encode(sseData)]);

    const provider = createMockProvider([
      { type: 'content_delta', content: 'hello' },
    ]);

    const result = await relayStream(upstream, clientRes, provider);

    expect(clientRes.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
    }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toEqual({ type: 'content_delta', content: 'hello' });
    expect(result.statusCode).toBe(200);
    expect(clientRes._written.some(w => w.includes('content_delta'))).toBe(true);
    // Should end with [DONE]
    expect(clientRes._written.at(-1)).toBe('data: [DONE]\n\n');
    expect(clientRes.end).toHaveBeenCalled();
  });

  it('handles stream with no body (returns empty result)', async () => {
    const upstream = { body: null } as unknown as Response;
    const provider = createMockProvider();

    const result = await relayStream(upstream, clientRes, provider);

    expect(result.chunks).toEqual([]);
    expect(result.ttft_ms).toBeNull();
    // The relay emitted a 502 to the client; the caller logs result.statusCode
    // rather than hard-coding 200 (which mislabelled this failure as success).
    expect(result.statusCode).toBe(502);
    expect(clientRes.writeHead).toHaveBeenCalledWith(502, expect.any(Object));
    expect(clientRes.end).toHaveBeenCalled();
  });

  it('reports clientAborted (and no [DONE]) when the client disconnects mid-stream', async () => {
    const abortRes = createAbortableClientResponse();
    const encoder = new TextEncoder();
    let reads = 0;
    const upstream = {
      body: {
        getReader: () => ({
          read: vi.fn(async () => {
            reads += 1;
            if (reads === 1) {
              abortRes.emit('close'); // client hangs up before we relay the chunk
              return { done: false, value: encoder.encode('data: {"content":"x"}\n\n') };
            }
            return { done: true, value: undefined };
          }),
          cancel: vi.fn(async () => {}),
        }),
      },
    } as unknown as Response;
    const provider = createMockProvider([{ type: 'content_delta', content: 'x' }]);

    const result = await relayStream(upstream, abortRes, provider);

    expect(result.clientAborted).toBe(true);
    expect(result.statusCode).toBe(200); // head was already committed before the abort
    // Once the client is gone we must not write the [DONE] sentinel.
    expect(abortRes._written.some((w) => w.includes('[DONE]'))).toBe(false);
    // A client-initiated abort is NOT an upstream stream failure.
    expect(result.streamError).toBeUndefined();
  });

  it('timeout on stalled read (30s timeout)', async () => {
    const stalling = {
      read: vi.fn(() => new Promise(() => { /* never resolves */ })),
    };
    const upstream = {
      body: { getReader: () => stalling },
    } as unknown as Response;

    const provider = createMockProvider();

    vi.useFakeTimers();
    const promise = relayStream(upstream, clientRes, provider);

    // Advance past the 30s timeout
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;
    vi.useRealTimers();

    // Should have written an error chunk
    const errorWritten = clientRes._written.some(w => w.includes('"type":"error"'));
    expect(errorWritten).toBe(true);
    expect(clientRes.end).toHaveBeenCalled();
  });

  it('records TTFT correctly for first content_delta chunk', async () => {
    const encoder = new TextEncoder();
    const sseData = 'data: {"content":"hi"}\n\n';
    const upstream = createMockUpstreamResponse([encoder.encode(sseData)]);

    const provider = createMockProvider([
      { type: 'content_delta', content: 'hi' },
    ]);

    const result = await relayStream(upstream, clientRes, provider);

    // ttft_ms should be a non-negative number (time from start to first content_delta)
    expect(result.ttft_ms).not.toBeNull();
    expect(result.ttft_ms).toBeGreaterThanOrEqual(0);
  });

  it('error chunk sent on parse failure', async () => {
    const encoder = new TextEncoder();
    const sseData = 'data: {"content":"ok"}\n\n';

    // Create upstream that throws on second read
    let callCount = 0;
    const mockReader = {
      read: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return { done: false, value: encoder.encode(sseData) };
        throw new Error('Parse failure');
      }),
    };
    const upstream = {
      body: { getReader: () => mockReader },
    } as unknown as Response;

    const provider = createMockProvider([
      { type: 'content_delta', content: 'ok' },
    ]);

    const result = await relayStream(upstream, clientRes, provider);

    const errorWritten = clientRes._written.some(w => w.includes('"type":"error"'));
    expect(errorWritten).toBe(true);
    expect(clientRes.end).toHaveBeenCalled();
  });

  it('relays every chunk when a provider returns an array for one SSE event', async () => {
    const encoder = new TextEncoder();
    const sseData = 'data: {"final":true}\n\n';
    const upstream = createMockUpstreamResponse([encoder.encode(sseData)]);
    // Mirrors Gemini bundling the trailing text delta with its done/usage chunk.
    const provider = {
      id: 'test-provider',
      buildRequest: vi.fn(),
      parseResponse: vi.fn(),
      parseStreamChunk: vi.fn(() => [
        { type: 'content_delta', content: ' world' },
        { type: 'done', stop_reason: 'end', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
      ]),
      extractUsage: vi.fn(() => ({ input_tokens: 1, output_tokens: 2, total_tokens: 3 })),
      normalizeError: vi.fn(() => ({ message: 'error', code: 'internal_error', status: 500 })),
    } as unknown as LLMProvider;

    const result = await relayStream(upstream, clientRes, provider);

    expect(result.chunks).toEqual([
      { type: 'content_delta', content: ' world' },
      { type: 'done', stop_reason: 'end', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } },
    ]);
    expect(clientRes._written.some((w) => w.includes(' world'))).toBe(true);
    expect(clientRes._written.some((w) => w.includes('"type":"done"'))).toBe(true);
  });

  it('waits for drain when client write backpressure occurs', async () => {
    const backpressureRes = createBackpressureClientResponse();
    const encoder = new TextEncoder();
    const sseData = 'data: {"content":"drain"}\n\n';
    const upstream = createMockUpstreamResponse([encoder.encode(sseData)]);
    const provider = createMockProvider([{ type: 'content_delta', content: 'drain' }]);

    const promise = relayStream(upstream, backpressureRes, provider);
    setTimeout(() => backpressureRes.emit('drain'), 0);

    const result = await promise;
    expect(result.chunks).toHaveLength(1);
    expect(backpressureRes.once).toHaveBeenCalledWith('drain', expect.any(Function));
    expect(backpressureRes.end).toHaveBeenCalled();
  });

  it('flags a mid-stream upstream failure as streamError (not a silent 200 success)', async () => {
    const encoder = new TextEncoder();
    let callCount = 0;
    const mockReader = {
      read: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return { done: false, value: encoder.encode('data: {"content":"ok"}\n\n') };
        throw new Error('upstream exploded'); // upstream dies mid-stream
      }),
    };
    const upstream = { body: { getReader: () => mockReader } } as unknown as Response;
    const provider = createMockProvider([{ type: 'content_delta', content: 'ok' }]);

    const result = await relayStream(upstream, clientRes, provider);

    // Wire status stays 200 (head already committed), but the failure is now
    // surfaced so the caller logs a distinct error_type instead of a clean 200 —
    // otherwise truncated/errored streams are invisible in analytics + alerting.
    expect(result.statusCode).toBe(200);
    expect(result.streamError).toBe('stream_failed');
    // The client still receives the in-band SSE error chunk.
    expect(clientRes._written.some((w) => w.includes('"type":"error"'))).toBe(true);
  });

  it('labels a stalled-read failure distinctly as stream_read_timeout', async () => {
    const stalling = { read: vi.fn(() => new Promise(() => { /* never resolves */ })) };
    const upstream = { body: { getReader: () => stalling } } as unknown as Response;
    const provider = createMockProvider();

    vi.useFakeTimers();
    const promise = relayStream(upstream, clientRes, provider);
    await vi.advanceTimersByTimeAsync(31_000);
    const result = await promise;
    vi.useRealTimers();

    expect(result.streamError).toBe('stream_read_timeout');
  });

  it('leaves streamError undefined on a clean stream', async () => {
    const encoder = new TextEncoder();
    const upstream = createMockUpstreamResponse([encoder.encode('data: {"content":"hi"}\n\n')]);
    const provider = createMockProvider([{ type: 'content_delta', content: 'hi' }]);

    const result = await relayStream(upstream, clientRes, provider);

    expect(result.streamError).toBeUndefined();
  });

  it('refreshes a reservation lease throughout 31 minutes of raw upstream activity', async () => {
    const encoder = new TextEncoder();
    const timestamps = [0, 5, 10, 15, 20, 25, 31].map((minutes) => minutes * 60_000);
    let index = 0;
    const reader = {
      read: vi.fn(async () => {
        if (index >= timestamps.length) return { done: true, value: undefined };
        vi.setSystemTime(timestamps[index]);
        index += 1;
        return { done: false, value: encoder.encode(': keepalive\n\n') };
      }),
      cancel: vi.fn(async () => {}),
    };
    const upstream = { body: { getReader: () => reader } } as unknown as Response;
    const refresh = vi.fn(async () => {});

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await relayStream(upstream, clientRes, createMockProvider(), { intervalMs: 5 * 60_000, refresh });
      expect(refresh).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes for keepalive-only bytes and throttles repeated reads within the lease interval', async () => {
    const encoder = new TextEncoder();
    const timestamps = [0, 5, 5, 5, 9].map((minutes) => minutes * 60_000);
    let index = 0;
    const reader = {
      read: vi.fn(async () => {
        if (index >= timestamps.length) return { done: true, value: undefined };
        vi.setSystemTime(timestamps[index]);
        index += 1;
        return { done: false, value: encoder.encode(': keepalive\n\n') };
      }),
      cancel: vi.fn(async () => {}),
    };
    const refresh = vi.fn(async () => {});

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const result = await relayStream(
        { body: { getReader: () => reader } } as unknown as Response,
        clientRes,
        createMockProvider(),
        { intervalMs: 5 * 60_000, refresh },
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(result.chunks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels upstream and stops delivery when reservation heartbeat fails', async () => {
    const encoder = new TextEncoder();
    const reader = {
      read: vi.fn(async () => {
        vi.setSystemTime(5 * 60_000);
        return { done: false, value: encoder.encode('data: {"content":"must not deliver"}\n\n') };
      }),
      // A broken upstream cancellation must not block the heartbeat-failure
      // result that causes the caller to retain an unknown-cost hold.
      cancel: vi.fn(() => new Promise<void>(() => {})),
    };
    const provider = createMockProvider([{ type: 'content_delta', content: 'must not deliver' }]);
    const refresh = vi.fn(async () => { throw new Error('reservation row missing'); });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const result = await relayStream(
        { body: { getReader: () => reader } } as unknown as Response,
        clientRes,
        provider,
        { intervalMs: 5 * 60_000, refresh },
      );
      expect(result.streamError).toBe('credit_reservation_heartbeat_failed');
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(provider.parseStreamChunk).not.toHaveBeenCalled();
      expect(clientRes._written.some((chunk) => chunk.includes('must not deliver'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when a reservation heartbeat never resolves', async () => {
    const encoder = new TextEncoder();
    const reader = {
      read: vi.fn(async () => {
        vi.setSystemTime(5 * 60_000);
        return { done: false, value: encoder.encode('data: {"content":"must not deliver"}\n\n') };
      }),
      cancel: vi.fn(async () => {}),
    };
    const provider = createMockProvider([{ type: 'content_delta', content: 'must not deliver' }]);
    const refresh = vi.fn(() => new Promise<void>(() => {}));

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const resultPromise = relayStream(
        { body: { getReader: () => reader } } as unknown as Response,
        clientRes,
        provider,
        { intervalMs: 5 * 60_000, refresh },
      );
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await resultPromise;

      expect(result.streamError).toBe('credit_reservation_heartbeat_failed');
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(provider.parseStreamChunk).not.toHaveBeenCalled();
      expect(clientRes._written.some((chunk) => chunk.includes('must not deliver'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves heartbeat-failure billing classification when the client closes during refresh', async () => {
    const abortRes = createAbortableClientResponse();
    const encoder = new TextEncoder();
    const reader = {
      read: vi.fn(async () => {
        vi.setSystemTime(5 * 60_000);
        return { done: false, value: encoder.encode('data: {"content":"must not deliver"}\n\n') };
      }),
      cancel: vi.fn(async () => {}),
    };
    const refresh = vi.fn(() => {
      abortRes.emit('close');
      return new Promise<void>(() => {});
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const resultPromise = relayStream(
        { body: { getReader: () => reader } } as unknown as Response,
        abortRes,
        createMockProvider([{ type: 'content_delta', content: 'must not deliver' }]),
        { intervalMs: 5 * 60_000, refresh },
      );
      await vi.advanceTimersByTimeAsync(31_000);
      const result = await resultPromise;

      expect(result.clientAborted).toBe(true);
      expect(result.streamError).toBe('credit_reservation_heartbeat_failed');
      expect(abortRes._written.some((chunk) => chunk.includes('must not deliver'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
