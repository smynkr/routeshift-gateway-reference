import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { extractToolCallsFromChunks } from '../src/logging/categorize.js';
import type { CanonicalRequest } from '@routeshift/shared';

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider();

  it('builds a valid request with system as top-level field', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'Hello' }],
        system_prompt: 'Be helpful.',
        stream: true,
      },
      'sk-ant-test',
    );
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(req.body);
    expect(body.system).toBe('Be helpful.');
    // Messages should NOT contain system message
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(body.max_tokens).toBe(8192);
    expect(body.stream).toBe(true);
  });

  it('preserves structured system blocks and cache-control metadata', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'Hello' }],
        system_prompt: [{
          type: 'text',
          text: 'Stable policy',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
        stream: false,
      },
      'key',
    );

    expect(JSON.parse(req.body).system).toEqual([{
      type: 'text',
      text: 'Stable policy',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }]);
  });

  it('has no adapter-local application seam for a self-attested cache plan', () => {
    const canonicalRequest: CanonicalRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      system_prompt: 'Stable policy',
      temperature: 0,
      stream: false,
    };

    const before = structuredClone(canonicalRequest);
    const buildWithUnexpectedApplication = provider.buildRequest.bind(provider) as (
      request: CanonicalRequest,
      apiKey: string,
      metadata: Record<string, unknown> | undefined,
      unexpectedApplication: unknown,
    ) => ReturnType<AnthropicProvider['buildRequest']>;
    const req = buildWithUnexpectedApplication(
      canonicalRequest,
      'key',
      undefined,
      {
        plan: {
          disposition: 'applied',
          overlay: { provider: 'anthropic', cacheControl: { type: 'ephemeral', ttl: '1h' } },
        },
        context: { credentialScope: 'team_byok', billingMode: 'subscription' },
      },
    );

    expect(JSON.parse(req.body).system).toBe('Stable policy');
    expect(canonicalRequest).toEqual(before);
  });

  it('ignores stale team-byok application context on an actual shared fallback request', () => {
    const canonicalRequest: CanonicalRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
      system_prompt: 'Shared fallback policy',
      temperature: 0,
      stream: false,
    };
    const buildWithUnexpectedApplication = provider.buildRequest.bind(provider) as (
      request: CanonicalRequest,
      apiKey: string,
      metadata: Record<string, unknown> | undefined,
      unexpectedApplication: unknown,
    ) => ReturnType<AnthropicProvider['buildRequest']>;

    const built = buildWithUnexpectedApplication(canonicalRequest, 'shared-key', undefined, {
      plan: {
        disposition: 'applied',
        overlay: { provider: 'anthropic', cacheControl: { type: 'ephemeral' } },
      },
      context: {
        billingMode: 'subscription',
        credentialScope: 'team_byok',
        previousCredentialScope: undefined,
      },
    });

    expect(JSON.parse(built.body).system).toBe('Shared fallback policy');
    expect(canonicalRequest.system_prompt).toBe('Shared fallback policy');
  });

  it('resolves canonical model name to API model ID', () => {
    const req = provider.buildRequest(
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.model).toBe('claude-sonnet-4-6-20250514');
  });

  it('uses provided max_output_tokens', () => {
    const req = provider.buildRequest(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'Hi' }], max_output_tokens: 500, stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.max_tokens).toBe(500);
  });

  it('includes temperature, tools, and object tool_choice when provided', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.2,
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup_weather',
              description: 'Lookup weather by city',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
        stream: false,
      },
      'key',
    );

    const body = JSON.parse(req.body);
    expect(body.temperature).toBe(0.2);
    expect(body.tools).toEqual([
      {
        name: 'lookup_weather',
        description: 'Lookup weather by city',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'lookup_weather' });
  });

  it('maps supported provider params to Anthropic fields', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        provider_params: { top_p: 0.7, stop: ['END'] },
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.top_p).toBe(0.7);
    expect(body.stop_sequences).toEqual(['END']);
  });

  it('maps string tool_choice variants', () => {
    const autoReq = provider.buildRequest(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'Hi' }], tool_choice: 'auto', stream: false },
      'key',
    );
    expect(JSON.parse(autoReq.body).tool_choice).toEqual({ type: 'auto' });

    const noneReq = provider.buildRequest(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'Hi' }], tool_choice: 'none', stream: false },
      'key',
    );
    expect(JSON.parse(noneReq.body).tool_choice).toEqual({ type: 'none' });

    const requiredReq = provider.buildRequest(
      { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'Hi' }], tool_choice: 'required', stream: false },
      'key',
    );
    expect(JSON.parse(requiredReq.body).tool_choice).toEqual({ type: 'any' });
  });

  it('falls back to raw model when registry mapping is missing', () => {
    const req = provider.buildRequest(
      { model: 'claude-custom', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key',
    );
    expect(JSON.parse(req.body).model).toBe('claude-custom');
  });

  it('translates an inbound tool conversation into Anthropic content blocks', () => {
    // Anthropic has no 'tool' role: assistant tool_calls become tool_use blocks
    // (input as a PARSED object), and role:'tool' results become tool_result
    // blocks inside a user turn. Without this a multi-turn tool conversation
    // sent verbatim ({role:'tool', ...}) is rejected by the Anthropic API.
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'user', content: 'weather in SF and NYC?' },
          {
            role: 'assistant',
            content: 'Let me check.',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
              { id: 'call_2', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
            ],
          },
          { role: 'tool', content: 'SF: sunny', tool_call_id: 'call_1' },
          { role: 'tool', content: 'NYC: rain', tool_call_id: 'call_2' },
        ],
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'weather in SF and NYC?' });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
        { type: 'tool_use', id: 'call_2', name: 'get_weather', input: { city: 'NYC' } },
      ],
    });
    // Consecutive tool results MERGE into one user turn (Anthropic's parallel shape).
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'SF: sunny' },
        { type: 'tool_result', tool_use_id: 'call_2', content: 'NYC: rain' },
      ],
    });
    expect(body.messages).toHaveLength(3);
  });

  it('fails closed when a tool result is missing tool_call_id', () => {
    expect(() => provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
          },
          { role: 'tool', content: 'result' },
        ],
        stream: false,
      },
      'key',
    )).toThrowError(expect.objectContaining({
      name: 'ProxyError',
      message: 'Anthropic tool result is missing tool_call_id',
      statusCode: 400,
      retryable: false,
      provider: 'anthropic',
    }));
  });

  it('fails closed when a tool result references an unknown tool_call_id', () => {
    expect(() => provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
          },
          { role: 'tool', content: 'result', tool_call_id: 'call_unknown' },
        ],
        stream: false,
      },
      'key',
    )).toThrowError(expect.objectContaining({
      name: 'ProxyError',
      message: 'Anthropic tool result references unknown tool_call_id "call_unknown"',
      statusCode: 400,
      retryable: false,
      provider: 'anthropic',
    }));
  });

  it('fails closed when a tool result appears before its assistant tool call', () => {
    expect(() => provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'tool', content: 'result', tool_call_id: 'call_1' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
          },
        ],
        stream: false,
      },
      'key',
    )).toThrowError(expect.objectContaining({
      name: 'ProxyError',
      message: 'Anthropic tool result references unknown tool_call_id "call_1"',
      statusCode: 400,
      retryable: false,
      provider: 'anthropic',
    }));
  });

  it('fails closed when a non-tool message interrupts unresolved tool results', () => {
    expect(() => provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"one"}' } },
              { id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{"q":"two"}' } },
            ],
          },
          { role: 'tool', content: 'first result', tool_call_id: 'call_1' },
          { role: 'user', content: 'skip the other result' },
          { role: 'tool', content: 'late second result', tool_call_id: 'call_2' },
        ],
        stream: false,
      },
      'key',
    )).toThrowError(expect.objectContaining({
      name: 'ProxyError',
      message: 'Anthropic tool result sequence was interrupted with unresolved tool_call_id(s): "call_2"',
      statusCode: 400,
      retryable: false,
      provider: 'anthropic',
    }));
  });

  it('translates array/multimodal tool results into native Anthropic blocks', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku',
        messages: [
          { role: 'user', content: 'check image' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_image', arguments: '{}' } }] },
          {
            role: 'tool',
            content: [
              { type: 'text', text: 'Source material' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } },
              {
                type: 'pdf',
                pdf: { media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
              },
            ],
            tool_call_id: 'c1',
          },
        ],
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'c1',
          content: [
            { type: 'text', text: 'Source material' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: '123' },
            },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
            },
          ],
        },
      ],
    });
  });

  it('translates remote image URLs in tool results into native URL sources', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_image', arguments: '{}' } }] },
          { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }], tool_call_id: 'c1' },
        ],
        stream: false,
      },
      'key',
    );

    expect(JSON.parse(req.body).messages[1].content[0].content).toEqual([{
      type: 'image',
      source: { type: 'url', url: 'https://example.com/image.png' },
    }]);
  });

  it('preserves array content before assistant tool_use blocks', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'user', content: 'inspect the report' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I found a relevant page.' },
              {
                type: 'pdf',
                pdf: { media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
              },
            ],
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'summarize_page', arguments: '{"page":1}' },
              },
            ],
          },
        ],
        stream: false,
      },
      'key',
    );

    expect(JSON.parse(req.body).messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I found a relevant page.' },
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
        },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'summarize_page',
          input: { page: 1 },
        },
      ],
    });
  });

  it('maps validated canonical PDFs to native document blocks', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [{
          role: 'user',
          content: [{
            type: 'pdf',
            pdf: { media_type: 'application/pdf', data: 'JVBERi0xLjQ=', filename: 'report.pdf' },
          }],
        }],
        stream: false,
      },
      'key',
    );

    expect(JSON.parse(req.body).messages[0].content).toEqual([{
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
    }]);
  });

  it('omits the text block and defaults invalid tool args to {} for a pure tool-call turn', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '' } }] },
        ],
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'f', input: {} }],
    });
  });

  it('leaves a plain assistant message untouched (no spurious blocks)', () => {
    const req = provider.buildRequest(
      {
        model: 'claude-haiku-4-5',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('parses complete non-stream response including stop reason and tool_use blocks', () => {
    const parsed = provider.parseResponse({
      id: 'msg_1',
      model: 'claude-haiku-4-5-20251022',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Hello ' },
        { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'NYC' } },
        { type: 'text', text: 'world' },
      ],
      usage: { input_tokens: 10, output_tokens: 15 },
    });

    expect(parsed).toEqual({
      id: 'msg_1',
      model: 'claude-haiku-4-5-20251022',
      content: 'Hello world',
      // tool_use blocks must be surfaced as canonical tool_calls so the OpenAI
      // formatter can forward them — otherwise the client gets a broken
      // finish_reason:"tool_calls" response with no tool_calls array.
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 15, total_tokens: 25, cache_read_tokens: 0, cache_write_tokens: 0 },
    });
  });

  it('omits tool_calls and serializes empty input correctly for text-only responses', () => {
    const textOnly = provider.parseResponse({
      id: 'msg_3',
      model: 'claude',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'just text' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(textOnly).not.toHaveProperty('tool_calls');

    // A tool_use block with no `input` must serialize to '{}', not 'undefined'.
    const noInput = provider.parseResponse({
      id: 'msg_4',
      model: 'claude',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't2', name: 'ping' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(noInput.tool_calls).toEqual([
      { id: 't2', type: 'function', function: { name: 'ping', arguments: '{}' } },
    ]);
  });

  it('defaults parseResponse fields when optional usage/content are absent', () => {
    const parsed = provider.parseResponse({ id: 'msg_2', model: 'claude', stop_reason: 'unknown' });

    expect(parsed).toEqual({
      id: 'msg_2',
      model: 'claude',
      content: '',
      stop_reason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    });
  });

  it('parses content_block_delta', () => {
    const chunk = provider.parseStreamChunk({
      event: 'content_block_delta',
      data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    });
    expect(chunk).toEqual({ type: 'content_delta', content: 'Hello' });
  });

  it('emits tool id/name from content_block_start with the block index', () => {
    const chunk = provider.parseStreamChunk({
      event: 'content_block_start',
      data: JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      }),
    });

    expect(chunk).toEqual({
      type: 'tool_call_delta',
      tool_call: { id: 'toolu_1', name: 'get_weather', arguments_delta: '', index: 1 },
    });
  });

  it('returns null for a non-tool content_block_start (text block)', () => {
    const chunk = provider.parseStreamChunk({
      event: 'content_block_start',
      data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    });
    expect(chunk).toBeNull();
  });

  it('parses tool JSON deltas from stream, carrying the block index', () => {
    const chunk = provider.parseStreamChunk({
      event: 'content_block_delta',
      data: JSON.stringify({ index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":"NYC"}' } }),
    });

    expect(chunk).toEqual({
      type: 'tool_call_delta',
      tool_call: { id: '', name: '', arguments_delta: '{"city":"NYC"}', index: 1 },
    });
  });

  it('reassembles a streamed Anthropic tool call end-to-end (start + deltas)', () => {
    const events = [
      { event: 'content_block_start', data: JSON.stringify({ index: 0, content_block: { type: 'tool_use', id: 'toolu_x', name: 'lookup' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } }) },
      { event: 'content_block_delta', data: JSON.stringify({ index: 0, delta: { type: 'input_json_delta', partial_json: '"hi"}' } }) },
    ];
    const chunks = events.map((e) => provider.parseStreamChunk(e)).filter(Boolean) as Array<{ tool_call: { id: string; name: string; arguments_delta: string; index?: number } }>;
    const reassembled = extractToolCallsFromChunks(chunks as any);
    expect(reassembled).toEqual([
      { id: 'toolu_x', type: 'function', function: { name: 'lookup', arguments: '{"q":"hi"}' } },
    ]);
  });

  it('returns null for unsupported content_block_delta types', () => {
    const chunk = provider.parseStreamChunk({
      event: 'content_block_delta',
      data: JSON.stringify({ delta: { type: 'something_else' } }),
    });
    expect(chunk).toBeNull();
  });

  it('extracts input tokens from message_start', () => {
    const chunk = provider.parseStreamChunk({
      event: 'message_start',
      data: JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: 25, output_tokens: 0 } },
      }),
    });
    expect(chunk).toEqual({
      type: 'usage',
      usage: { input_tokens: 25, output_tokens: 0, total_tokens: 25, cache_read_tokens: 0, cache_write_tokens: 0 },
    });
  });

  it('extracts output tokens from message_delta', () => {
    const chunk = provider.parseStreamChunk({
      event: 'message_delta',
      data: JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 42 },
      }),
    });
    expect(chunk).toEqual({
      type: 'done',
      stop_reason: 'end',
      usage: { input_tokens: 0, output_tokens: 42, total_tokens: 42 },
    });
  });

  it('maps additional stop reasons in message_delta', () => {
    const maxTokens = provider.parseStreamChunk({
      event: 'message_delta',
      data: JSON.stringify({ delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } }),
    });
    expect(maxTokens).toEqual({
      type: 'done',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
    });

    const stopSequence = provider.parseStreamChunk({
      event: 'message_delta',
      data: JSON.stringify({ delta: { stop_reason: 'stop_sequence' }, usage: { output_tokens: 2 } }),
    });
    expect(stopSequence).toEqual({
      type: 'done',
      stop_reason: 'end',
      usage: { input_tokens: 0, output_tokens: 2, total_tokens: 2 },
    });
  });

  it('returns null for message_stop', () => {
    const chunk = provider.parseStreamChunk({
      event: 'message_stop',
      data: JSON.stringify({ type: 'message_stop' }),
    });
    expect(chunk).toBeNull();
  });

  it('returns null for non-content stream control events and invalid JSON', () => {
    expect(provider.parseStreamChunk({ event: 'content_block_start', data: '{}' })).toBeNull();
    expect(provider.parseStreamChunk({ event: 'content_block_stop', data: '{}' })).toBeNull();
    expect(provider.parseStreamChunk({ event: 'ping', data: '{}' })).toBeNull();
    expect(provider.parseStreamChunk({ event: 'unknown', data: '{}' })).toBeNull();
    expect(provider.parseStreamChunk({ event: 'message_delta', data: '{' })).toBeNull();
  });

  it('combines usage from multiple chunks', () => {
    const chunks = [
      { type: 'usage' as const, usage: { input_tokens: 25, output_tokens: 0, total_tokens: 25 } },
      { type: 'content_delta' as const, content: 'Hi' },
      { type: 'done' as const, stop_reason: 'end' as const, usage: { input_tokens: 0, output_tokens: 42, total_tokens: 42 } },
    ];
    const usage = provider.extractUsage(chunks);
    expect(usage).toEqual({ input_tokens: 25, output_tokens: 42, total_tokens: 67, cache_read_tokens: 0, cache_write_tokens: 0 });
  });

  it('extractUsage defaults to zero usage when chunks do not contain usage/done', () => {
    const usage = provider.extractUsage([{ type: 'content_delta', content: 'only text' }]);
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  });

  it('normalizes errors correctly', () => {
    const err429 = provider.normalizeError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } });
    expect(err429.retryable).toBe(true);
    expect(err429.provider).toBe('anthropic');

    const err529 = provider.normalizeError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    expect(err529.retryable).toBe(true);

    const err400 = provider.normalizeError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Bad' } });
    expect(err400.retryable).toBe(false);
  });

  it('normalizes unknown error shapes with default message', () => {
    const err = provider.normalizeError(500, { foo: 'bar' });
    expect(err.message).toBe('Unknown Anthropic error');
    expect(err.retryable).toBe(true);
  });
});
