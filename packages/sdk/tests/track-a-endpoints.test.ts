import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProxyClient } from '../src/client';
import type { EmbeddingResponse, StreamEvent } from '../src/types';

describe('ProxyClient — Track A endpoints', () => {
  const client = new ProxyClient({
    baseUrl: 'https://proxy.example.com',
    apiKey: 'sk-proxy-live_test_abc123',
  });

  beforeEach(() => { vi.restoreAllMocks(); });

  // ── models.list ────────────────────────────────────────────────────────────

  describe('models.list()', () => {
    it('hits GET /v1/models with bearer auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ object: 'list', data: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.models.list();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://proxy.example.com/v1/models',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-proxy-live_test_abc123',
          }),
        }),
      );
    });

    it('returns the parsed ModelList', async () => {
      const payload = { object: 'list', data: [{ id: 'gpt-4.1', object: 'model', created: 1, owned_by: 'openai' }] };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) }));

      const result = await client.models.list();
      expect(result).toEqual(payload);
    });

    it('respects baseUrl trailing-slash strip', async () => {
      const c = new ProxyClient({ baseUrl: 'https://proxy.example.com/', apiKey: 'key' });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ object: 'list', data: [] }) }));
      await c.models.list();
      expect((fetch as any).mock.calls[0][0]).toBe('https://proxy.example.com/v1/models');
    });
  });

  // ── models.get ─────────────────────────────────────────────────────────────

  describe('models.get(id)', () => {
    it('hits GET /v1/models/:id with bearer auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'gpt-5.4', object: 'model', created: 1, owned_by: 'openai' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.models.get('gpt-5.4');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://proxy.example.com/v1/models/gpt-5.4',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-proxy-live_test_abc123',
          }),
        }),
      );
    });

    it('returns the parsed Model', async () => {
      const payload = { id: 'gpt-5.4', object: 'model', created: 1234567890, owned_by: 'openai' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) }));

      const result = await client.models.get('gpt-5.4');
      expect(result).toEqual(payload);
    });

    it('URL-encodes slashes in model id', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 'ns/model' }) }));
      await client.models.get('ns/model');
      expect((fetch as any).mock.calls[0][0]).toBe('https://proxy.example.com/v1/models/ns%2Fmodel');
    });
  });

  // ── generation.get ─────────────────────────────────────────────────────────

  describe('generation.get(id)', () => {
    it('hits GET /api/v1/generation?id=<id> with bearer auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { id: 'req_1', model: 'gpt-4.1' } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.generation.get('req_1');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://proxy.example.com/api/v1/generation?id=req_1',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-proxy-live_test_abc123',
          }),
        }),
      );
    });

    it('unwraps the {data} envelope and returns the inner Generation', async () => {
      const gen = {
        id: 'req_1', model: 'gpt-5.4', provider_name: 'azure', created_at: '2026-06-01T00:00:00.000Z',
        streamed: false, cancelled: null, tokens_prompt: 100, tokens_completion: 20,
        total_cost: 0.0124, cache_discount: null, latency: 1800, generation_time: 1640,
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: gen }) }));

      const result = await client.generation.get('req_1');
      expect(result).toEqual(gen); // unwrapped — not the {data:...} envelope
      expect(result.total_cost).toBe(0.0124);
    });

    it('properly encodes special characters in generation id', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: 'a b' } }) }));
      await client.generation.get('a b');
      const url: string = (fetch as any).mock.calls[0][0];
      // URLSearchParams encodes space as '+' (application/x-www-form-urlencoded), not %20
      expect(url).toContain('id=a+b');
    });

    it('uses the RouteShift request id from chat() for generation.get()', async () => {
      const routeShiftRequestId = 'req_header_123';
      const upstreamCompletionId = 'chatcmpl_body_456';
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'X-RouteShift-Request-Id': routeShiftRequestId }),
          json: () => Promise.resolve({
            id: upstreamCompletionId,
            choices: [],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ data: { id: routeShiftRequestId, model: 'gpt-4.1' } }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const chat = await client.chat({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      expect(chat.id).toBe(upstreamCompletionId);
      expect(chat._routeshift_request_id).toBe(routeShiftRequestId);
      expect(Object.keys(chat)).not.toContain('_routeshift_request_id');

      await client.generation.get(chat._routeshift_request_id!);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const generationUrl = mockFetch.mock.calls[1][0] as string;
      expect(generationUrl).toBe(`https://proxy.example.com/api/v1/generation?id=${routeShiftRequestId}`);
      expect(generationUrl).not.toContain(upstreamCompletionId);
    });
  });

  // ── chatStream ─────────────────────────────────────────────────────────────

  describe('chatStream()', () => {
    it('exposes the RouteShift request id on parsed stream events', async () => {
      const routeShiftRequestId = 'req_stream_123';
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', content: 'Hi' })}\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n'));
          controller.close();
        },
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'X-RouteShift-Request-Id': routeShiftRequestId }),
        body: stream,
      }));

      const events: StreamEvent[] = [];
      for await (const event of client.chatStream({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        events.push(event);
      }

      expect(events[0]?._routeshift_request_id).toBe(routeShiftRequestId);
      expect(Object.keys(events[0]!)).not.toContain('_routeshift_request_id');
    });
  });

  // ── embeddings.create ──────────────────────────────────────────────────────

  describe('embeddings.create(params)', () => {
    it('hits POST /v1/embeddings with bearer auth', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ object: 'list', data: [], model: 'text-embedding-3-small', usage: { prompt_tokens: 1, total_tokens: 1 } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await client.embeddings.create({ model: 'text-embedding-3-small', input: 'hi' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://proxy.example.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-proxy-live_test_abc123',
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('sends correct JSON body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ object: 'list', data: [], model: 'text-embedding-3-small', usage: { prompt_tokens: 1, total_tokens: 1 } }),
      }));

      await client.embeddings.create({ model: 'text-embedding-3-small', input: 'hi' });

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body).toEqual({ model: 'text-embedding-3-small', input: 'hi' });
    });

    it('sends array input correctly', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ object: 'list', data: [], model: 'text-embedding-3-small', usage: { prompt_tokens: 2, total_tokens: 2 } }),
      }));

      await client.embeddings.create({ model: 'text-embedding-3-small', input: ['hello', 'world'], encoding_format: 'float' });

      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.input).toEqual(['hello', 'world']);
      expect(body.encoding_format).toBe('float');
    });

    it('returns the parsed EmbeddingResponse', async () => {
      const payload = {
        object: 'list' as const,
        data: [{ object: 'embedding' as const, embedding: [0.1, 0.2], index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) }));

      const result = await client.embeddings.create({ model: 'text-embedding-3-small', input: 'hi' });
      expect(result).toEqual(payload);
    });

    it("handles base64 embedding strings when encoding_format is 'base64'", async () => {
      const payload: EmbeddingResponse = {
        object: 'list',
        data: [{ object: 'embedding', embedding: 'AQIDBA==', index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 1, total_tokens: 1 },
      };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) }));

      const result = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: 'hi',
        encoding_format: 'base64',
      });

      expect(result.data[0]?.embedding).toBe('AQIDBA==');
      expect(typeof result.data[0]?.embedding).toBe('string');
      const body = JSON.parse((fetch as any).mock.calls[0][1].body);
      expect(body.encoding_format).toBe('base64');
    });
  });
});
