import { describe, it, expect } from 'vitest';
import { GeminiProvider } from '../src/providers/gemini.js';
import { toOpenAIChatCompletion } from '../src/providers/openai-format.js';

describe('GeminiProvider', () => {
  const provider = new GeminiProvider();

  it('builds a streaming request with correct URL', () => {
    const req = provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hello' }], stream: true },
      'test-api-key',
    );
    expect(req.url).toContain('/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(req.headers['x-goog-api-key']).toBe('test-api-key');
  });

  it('dispatches the verified Gemini 3.7 Flash model ID without rewriting it', () => {
    const req = provider.buildRequest(
      { model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'Hello' }], stream: false },
      'test-api-key',
    );
    expect(req.url).toContain('/models/gemini-3.7-flash:generateContent');
  });

  it('builds a non-streaming request', () => {
    const req = provider.buildRequest(
      { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key',
    );
    expect(req.url).toContain('/models/gemini-2.5-pro:generateContent');
    expect(req.url).not.toContain('alt=sse');
  });

  it('maps roles correctly (assistant → model)', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
          { role: 'user', content: 'How are you?' },
        ],
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.contents[1].role).toBe('model');
  });

  it('puts system_prompt in systemInstruction', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
        system_prompt: 'Be helpful.',
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be helpful.' }] });
  });

  it('maps structured system blocks into systemInstruction parts', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
        system_prompt: [{ type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } }],
        stream: false,
      },
      'key',
    );
    expect(JSON.parse(req.body).systemInstruction).toEqual({ parts: [{ text: 'Be helpful.' }] });
  });

  it('maps max_output_tokens to generationConfig', () => {
    const req = provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }], max_output_tokens: 1000, temperature: 0.5, stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig.maxOutputTokens).toBe(1000);
    expect(body.generationConfig.temperature).toBe(0.5);
  });

  it('uses numeric thinking budgets for Gemini 2.5', () => {
    const body = JSON.parse(provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'medium', thinking_budget_tokens: 4096, stream: false },
      'key',
    ).body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 4096 });
  });

  it('maps reasoning effort to the documented Gemini 2.5 budget when no explicit budget exists', () => {
    const body = JSON.parse(provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'high', stream: false },
      'key',
    ).body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 24576 });
  });

  it('uses thinking levels for Gemini 3+ models', () => {
    const body = JSON.parse(provider.buildRequest(
      { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'Hi' }], thinking_level: 'minimal', stream: false },
      'key',
    ).body);
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('returns exact configuration reasons for unsupported Gemini thinking controls', () => {
    expect(() => provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }], thinking_level: 'low', stream: false }, 'key',
    )).toThrow('does not support thinking_level; use thinking_budget_tokens for Gemini 2.5 models');
    expect(() => provider.buildRequest(
      { model: 'gemini-3.1-pro', messages: [{ role: 'user', content: 'Hi' }], thinking_level: 'minimal', stream: false }, 'key',
    )).toThrow("does not support thinking_level 'minimal'; supported levels: low, medium, high");
    expect(() => provider.buildRequest(
      { model: 'gemini-3.5-flash', messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'low', thinking_budget_tokens: 1024, stream: false }, 'key',
    )).toThrow('cannot be combined with thinking_budget_tokens for Gemini 3+ models');
  });

  it('maps supported provider params to generationConfig', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        provider_params: {
          top_p: 0.8,
          frequency_penalty: 0.2,
          presence_penalty: 0.1,
          stop: ['END'],
        },
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig).toMatchObject({
      topP: 0.8,
      frequencyPenalty: 0.2,
      presencePenalty: 0.1,
      stopSequences: ['END'],
    });
  });

  it('translates response_format json_object to responseMimeType with no schema', () => {
    const req = provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' }, stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toBeUndefined();
  });

  it('translates response_format json_schema to responseJsonSchema losslessly', () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toEqual(schema);
  });

  it('translates the repo-internal {type:json, schema} response_format', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const req = provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json', schema }, stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toEqual(schema);
  });

  it('does not impose structured output for response_format text', () => {
    const req = provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'text' }, stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig?.responseMimeType).toBeUndefined();
    expect(body.generationConfig?.responseJsonSchema).toBeUndefined();
  });

  it('does not set responseMimeType when response_format is absent', () => {
    const req = provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig?.responseMimeType).toBeUndefined();
  });

  it('merges structured output with other generationConfig params', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } } };
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
        response_format: { type: 'json_schema', json_schema: { name: 'r', schema } },
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig.temperature).toBe(0.3);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseJsonSchema).toEqual(schema);
  });

  it('declares tools as functionDeclarations using parametersJsonSchema', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'w',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
          },
        ],
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'w',
            parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
    ]);
  });

  it('passes tool parameters through parametersJsonSchema losslessly (keeps non-OpenAPI-subset keywords)', () => {
    const schema = {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    };
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'weather?' }],
        tools: [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: schema } }],
        stream: false,
      },
      'key',
    );
    const decl = JSON.parse(req.body).tools[0].functionDeclarations[0];
    // additionalProperties is NOT in Gemini's OpenAPI subset; the JSON-Schema field carries it verbatim.
    expect(decl.parametersJsonSchema).toEqual(schema);
    // The lossy OpenAPI-subset `parameters` field must NOT be used.
    expect(decl.parameters).toBeUndefined();
  });

  it('omits parametersJsonSchema when a tool declares no parameters', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'now?' }],
        tools: [{ type: 'function', function: { name: 'get_time', description: 't' } }],
        stream: false,
      },
      'key',
    );
    const decl = JSON.parse(req.body).tools[0].functionDeclarations[0];
    expect(decl).toEqual({ name: 'get_time', description: 't' });
    expect('parametersJsonSchema' in decl).toBe(false);
  });

  it('maps tool_choice variants to functionCallingConfig modes', () => {
    const cfg = (tool_choice: unknown) =>
      JSON.parse(
        provider.buildRequest(
          { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'x' }], tool_choice: tool_choice as never, stream: false },
          'key',
        ).body,
      ).toolConfig;
    expect(cfg('auto')).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(cfg('none')).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(cfg('required')).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(cfg({ type: 'function', function: { name: 'get_weather' } })).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('does not include tools/toolConfig when none are requested', () => {
    const body = JSON.parse(
      provider.buildRequest(
        { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'hi' }], stream: false },
        'key',
      ).body,
    );
    expect(body.tools).toBeUndefined();
    expect(body.toolConfig).toBeUndefined();
  });

  it('translates an inbound tool conversation into functionCall/functionResponse parts', () => {
    // Gemini uses role:'model' functionCall parts and role:'user' functionResponse
    // parts. functionResponse requires the function NAME, which is recovered from
    // the originating assistant tool_call by id.
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'weather in SF?' },
          { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }] },
          { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
        ],
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Let me check.' },
        { functionCall: { name: 'get_weather', id: 'call_1', args: { city: 'SF' } } },
      ],
    });
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', id: 'call_1', response: { result: 'sunny' } } }],
    });
  });

  it('round-trips a Gemini 3 thoughtSignature through the OpenAI-compatible tool turn', () => {
    const upstream = {
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: { name: 'get_weather', id: 'call_1', args: { city: 'SF' } },
            thoughtSignature: 'signed-context',
          }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    };
    const canonical = provider.parseResponse(upstream);
    const response = toOpenAIChatCompletion(canonical, 'gemini-3-flash', upstream);
    const assistant = response.choices[0].message;

    const followUp = provider.buildRequest({
      model: 'gemini-3-flash',
      messages: [
        { role: 'user', content: 'weather in SF?' },
        { role: 'assistant', content: assistant.content ?? '', tool_calls: assistant.tool_calls },
        { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
      ],
      stream: false,
    }, 'key');

    expect(response.choices[0].message.tool_calls?.[0].extra_content).toEqual({
      google: { thought_signature: 'signed-context' },
    });
    expect(JSON.parse(followUp.body).contents[1]).toEqual({
      role: 'model',
      parts: [{
        functionCall: { name: 'get_weather', id: 'call_1', args: { city: 'SF' } },
        thoughtSignature: 'signed-context',
      }],
    });
  });

  it('groups parallel tool results into one user turn with matching functionResponse parts', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'weather in SF and NYC?' },
          {
            role: 'assistant',
            content: '',
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
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [
        { functionCall: { name: 'get_weather', id: 'call_1', args: { city: 'SF' } } },
        { functionCall: { name: 'get_weather', id: 'call_2', args: { city: 'NYC' } } },
      ],
    });
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'get_weather', id: 'call_1', response: { result: 'SF: sunny' } } },
        { functionResponse: { name: 'get_weather', id: 'call_2', response: { result: 'NYC: rain' } } },
      ],
    });
    expect(body.contents).toHaveLength(3);
  });

  it('preserves assistant array content before functionCall parts', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'read the report' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will inspect it.' },
              { type: 'pdf', pdf: { media_type: 'application/pdf', data: 'JVBERi0xLjQ=' } },
            ],
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'inspect_report', arguments: '{}' } },
            ],
          },
        ],
        stream: false,
      },
      'key',
    );
    expect(JSON.parse(req.body).contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'I will inspect it.' },
        { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0xLjQ=' } },
        { functionCall: { name: 'inspect_report', id: 'call_1', args: {} } },
      ],
    });
  });

  it('fails closed when a tool result cannot be correlated to a function name', () => {
    expect(() => provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'tool', content: 'sunny', tool_call_id: 'unknown' }],
        stream: false,
      },
      'key',
    )).toThrow('Gemini tool result references unknown tool_call_id: unknown');

    expect(() => provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'tool', content: 'sunny' }],
        stream: false,
      },
      'key',
    )).toThrow('Gemini tool result is missing tool_call_id');
  });

  it('fails closed when a tool result appears before its assistant functionCall', () => {
    expect(() => provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
            ],
          },
        ],
        stream: false,
      },
      'key',
    )).toThrow('Gemini tool result references unknown tool_call_id: call_1');
  });

  it('fails closed when a tool result reuses an already consumed functionCall id', () => {
    expect(() => provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
            ],
          },
          { role: 'tool', content: 'sunny', tool_call_id: 'call_1' },
          { role: 'tool', content: 'still sunny', tool_call_id: 'call_1' },
        ],
        stream: false,
      },
      'key',
    )).toThrow('Gemini tool result references unknown tool_call_id: call_1');
  });

  it('fails closed when a non-tool message interrupts unresolved parallel function responses', () => {
    const pendingConversation = [
      {
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function' as const, function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
          { id: 'call_2', type: 'function' as const, function: { name: 'get_weather', arguments: '{"city":"NYC"}' } },
        ],
      },
      { role: 'tool' as const, content: 'sunny', tool_call_id: 'call_1' },
    ];

    for (const interruption of [
      { role: 'user' as const, content: 'Never mind.' },
      { role: 'assistant' as const, content: 'Moving on.' },
    ]) {
      expect(() => provider.buildRequest(
        {
          model: 'gemini-2.5-flash',
          messages: [...pendingConversation, interruption],
          stream: false,
        },
        'key',
      )).toThrow(`Gemini function responses remain unresolved before ${interruption.role} message: call_2`);
    }
  });

  it('maps Gemini 3 multimodal tool results to native functionResponse parts', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-3-flash-preview',
        messages: [
          { role: 'user', content: 'check image' },
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_image', arguments: '{}' } }] },
          {
            role: 'tool',
            content: [
              { type: 'text', text: 'image result' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } },
              { type: 'pdf', pdf: { media_type: 'application/pdf', data: 'JVBERi0xLjQ=' } },
            ],
            tool_call_id: 'c1',
          },
        ],
        stream: false,
      },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [{
        functionResponse: {
          name: 'get_image',
          id: 'c1',
          response: { result: 'image result' },
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: '123' } },
            { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0xLjQ=' } },
          ],
        },
      }],
    });
  });

  it('fails closed for multimodal function responses on pre-Gemini 3 models', () => {
    expect(() => provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_image', arguments: '{}' } }] },
          { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,123' } }], tool_call_id: 'c1' },
        ],
        stream: false,
      },
      'key',
    )).toThrow('Gemini multimodal function responses require a Gemini 3 model, received "gemini-2.5-flash"');
  });

  it('fails closed for remote image URLs in Gemini multimodal function responses', () => {
    expect(() => provider.buildRequest(
      {
        model: 'gemini-3-flash-preview',
        messages: [
          { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_image', arguments: '{}' } }] },
          { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }], tool_call_id: 'c1' },
        ],
        stream: false,
      },
      'key',
    )).toThrow('Gemini multimodal function responses require inline data image URLs');
  });

  it('maps validated canonical PDFs to native inlineData parts', () => {
    const req = provider.buildRequest(
      {
        model: 'gemini-2.5-flash',
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

    expect(JSON.parse(req.body).contents[0].parts).toEqual([{
      inlineData: { mimeType: 'application/pdf', data: 'JVBERi0xLjQ=' },
    }]);
  });

  it('parses functionCall parts into canonical tool_calls and sets tool_use stop reason', () => {
    const response = provider.parseResponse({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'get_weather', id: 'call_9', args: { city: 'SF' } } }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
    });
    expect(response.tool_calls).toEqual([
      { id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
    ]);
    expect(response.stop_reason).toBe('tool_use');
  });

  it('generates an id for a functionCall that lacks one (older Gemini models)', () => {
    const response = provider.parseResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }], role: 'model' }, finishReason: 'STOP' }],
    });
    expect(response.tool_calls?.[0].id).toBeTruthy();
    expect(response.tool_calls?.[0].function).toEqual({ name: 'f', arguments: '{}' });
  });

  it('emits a tool_call_delta for a streamed functionCall part', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', id: 'call_1', args: { city: 'SF' } } }], role: 'model' }, finishReason: null }],
      }),
    });
    expect(chunk).toEqual({
      type: 'tool_call_delta',
      tool_call: { id: 'call_1', name: 'get_weather', arguments_delta: '{"city":"SF"}', index: 0 },
    });
  });

  it('preserves a streamed Gemini thoughtSignature as OpenAI-compatible extra_content', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{
          content: {
            parts: [{
              functionCall: { name: 'get_weather', id: 'call_1', args: { city: 'SF' } },
              thoughtSignature: 'stream-signed-context',
            }],
            role: 'model',
          },
          finishReason: null,
        }],
      }),
    });
    expect(chunk).toEqual({
      type: 'tool_call_delta',
      tool_call: {
        id: 'call_1',
        name: 'get_weather',
        arguments_delta: '{"city":"SF"}',
        index: 0,
        extra_content: { google: { thought_signature: 'stream-signed-context' } },
      },
    });
  });

  it('generates an id for a streamed functionCall that lacks one (older Gemini models)', () => {
    // Gemini < 3 omits functionCall.id when streaming. An empty id would be
    // replayed by the client as an empty tool_call_id, which buildRequest then
    // cannot map back to a function name — breaking the next tool turn. Mirror
    // the non-streaming parseResponse and synthesize an id.
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: { a: 1 } } }], role: 'model' }, finishReason: null }],
      }),
    }) as { type: string; tool_call: { id: string; name: string; arguments_delta: string; index: number } };
    expect(chunk.type).toBe('tool_call_delta');
    expect(chunk.tool_call.id).toBeTruthy();
    expect(typeof chunk.tool_call.id).toBe('string');
    expect(chunk.tool_call.name).toBe('f');
    expect(chunk.tool_call.arguments_delta).toBe('{"a":1}');
    expect(chunk.tool_call.index).toBe(0);
  });

  it('emits tool_call_delta(s) before a tool_use done chunk when functionCall is bundled with finishReason', () => {
    const chunks = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'f', id: 'c1', args: {} } }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }),
    });
    expect(chunks).toEqual([
      { type: 'tool_call_delta', tool_call: { id: 'c1', name: 'f', arguments_delta: '{}', index: 0 } },
      { type: 'done', stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, cache_read_tokens: 0 } },
    ]);
  });

  it('parses streaming content delta', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Hello' }], role: 'model' }, finishReason: null }],
      }),
    });
    expect(chunk).toEqual({ type: 'content_delta', content: 'Hello' });
  });

  it('parses streaming finish with usage', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, cachedContentTokenCount: 7 },
      }),
    });
    expect(chunk).toEqual({
      type: 'done',
      stop_reason: 'end',
      // promptTokenCount (10) already includes cachedContentTokenCount (7).
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 15, cache_read_tokens: 7 },
    });
  });

  it('captures Gemini thought-token telemetry in streaming usage', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 22 },
      }),
    });
    expect(chunk).toEqual({
      type: 'done', stop_reason: 'end',
      usage: { input_tokens: 10, output_tokens: 12, reasoning_tokens: 7, total_tokens: 22, cache_read_tokens: 0 },
    });
  });

  it('emits final text bundled with finishReason as a delta BEFORE the done chunk (no truncation)', () => {
    // Gemini commonly puts the last text segment in the same chunk as finishReason.
    const chunks = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ text: ' world' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      }),
    });
    expect(chunks).toEqual([
      { type: 'content_delta', content: ' world' },
      { type: 'done', stop_reason: 'end', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, cache_read_tokens: 0 } },
    ]);
  });

  it('maps SAFETY finish reason', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ finishReason: 'SAFETY' }],
      }),
    });
    expect(chunk?.stop_reason).toBe('safety');
  });

  it('normalizes errors with retryability', () => {
    const err429 = provider.normalizeError(429, { error: { message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
    expect(err429.retryable).toBe(true);

    const err400 = provider.normalizeError(400, { error: { message: 'Bad request', status: 'INVALID_ARGUMENT' } });
    expect(err400.retryable).toBe(false);
  });

  it('parses a non-streaming response', () => {
    const response = provider.parseResponse({
      candidates: [{
        content: { parts: [{ text: 'Hello there!' }], role: 'model' },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
    });
    expect(response.content).toBe('Hello there!');
    expect(response.stop_reason).toBe('end');
    expect(response.usage).toEqual({ input_tokens: 8, output_tokens: 4, total_tokens: 12, cache_read_tokens: 0 });
  });

  it('accounts for Gemini thought tokens as billable output and preserves telemetry', () => {
    const response = provider.parseResponse({
      candidates: [{ content: { parts: [{ text: 'Answer' }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 11, totalTokenCount: 23 },
    });
    expect(response.usage).toEqual({ input_tokens: 8, output_tokens: 15, reasoning_tokens: 11, total_tokens: 23, cache_read_tokens: 0 });
  });

  it('parses cache-read tokens from a non-streaming response', () => {
    const response = provider.parseResponse({
      candidates: [{
        content: { parts: [{ text: 'Hello cached content' }], role: 'model' },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 30,
        candidatesTokenCount: 4,
        totalTokenCount: 34,
        cachedContentTokenCount: 21,
      },
    });
    // promptTokenCount (30) already includes cachedContentTokenCount (21).
    expect(response.usage).toEqual({ input_tokens: 9, output_tokens: 4, total_tokens: 34, cache_read_tokens: 21 });
    expect(response.usage.cache_write_tokens).toBeUndefined();
  });

  it('concatenates all text parts in a multi-part non-streaming response', () => {
    // Gemini can split one candidate's content across multiple text parts;
    // reading only parts[0] silently truncated the response.
    const response = provider.parseResponse({
      candidates: [{
        content: { parts: [{ text: 'Hello ' }, { text: 'there' }, { text: '!' }], role: 'model' },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
    });
    expect(response.content).toBe('Hello there!');
  });

  it('concatenates multi-part text bundled with finishReason in a stream chunk', () => {
    const chunk = provider.parseStreamChunk({
      event: 'message',
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'foo' }, { text: 'bar' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
      }),
    });
    expect(chunk).toEqual([
      { type: 'content_delta', content: 'foobar' },
      { type: 'done', stop_reason: 'end', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3, cache_read_tokens: 0 } },
    ]);
  });

  it('maps MAX_TOKENS finish reason', () => {
    const response = provider.parseResponse({
      candidates: [{
        content: { parts: [{ text: 'partial' }], role: 'model' },
        finishReason: 'MAX_TOKENS',
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 100, totalTokenCount: 105 },
    });
    expect(response.stop_reason).toBe('max_tokens');
  });

  it('extracts usage from chunk array', () => {
    const chunks = [
      { type: 'content_delta' as const, content: 'Hi' },
      { type: 'done' as const, stop_reason: 'end' as const, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
    ];
    const usage = provider.extractUsage(chunks);
    expect(usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });

  it('extracts cache-read tokens from a streaming usage chunk', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 7,
          totalTokenCount: 27,
          cachedContentTokenCount: 14,
        },
      }),
    });
    expect(chunk).toEqual({
      type: 'usage',
      // promptTokenCount (20) already includes cachedContentTokenCount (14).
      usage: { input_tokens: 6, output_tokens: 7, total_tokens: 27, cache_read_tokens: 14 },
    });
    if (!chunk || Array.isArray(chunk)) throw new Error('expected a single usage chunk');
    expect(provider.extractUsage([chunk])).toEqual({
      input_tokens: 6,
      output_tokens: 7,
      total_tokens: 27,
      cache_read_tokens: 14,
    });
  });

  it('estimates streaming output usage when no chunks have usage', () => {
    const chunks = [
      { type: 'content_delta' as const, content: 'Hi' },
    ];
    const usage = provider.extractUsage(chunks);
    expect(usage).toEqual({ input_tokens: 0, output_tokens: 1, total_tokens: 1 });
  });

  it('normalizes 5xx errors as retryable', () => {
    const err500 = provider.normalizeError(500, { error: { message: 'Internal server error' } });
    expect(err500.retryable).toBe(true);

    const err503 = provider.normalizeError(503, { error: { message: 'Service unavailable' } });
    expect(err503.retryable).toBe(true);
  });

  it('handles unknown error body gracefully', () => {
    const err = provider.normalizeError(422, null);
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('Unknown Gemini error');
    expect(err.provider).toBe('google');
  });

  it('uses default base URL when none provided', () => {
    const defaultProvider = new GeminiProvider();
    const req = defaultProvider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key',
    );
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  });

  it('does not include systemInstruction when no system_prompt', () => {
    const req = provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.systemInstruction).toBeUndefined();
  });

  it('does not include generationConfig when no params set', () => {
    const req = provider.buildRequest(
      { model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'Hi' }], stream: false },
      'key',
    );
    const body = JSON.parse(req.body);
    expect(body.generationConfig).toBeUndefined();
  });

  it('maps RECITATION finish reason to safety', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ finishReason: 'RECITATION' }],
      }),
    });
    expect(chunk?.stop_reason).toBe('safety');
  });

  it('returns null for empty candidate content in stream', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({
        candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: null }],
      }),
    });
    expect(chunk).toBeNull();
  });

  it('returns null for invalid JSON stream chunks', () => {
    const chunk = provider.parseStreamChunk({ data: '{' });
    expect(chunk).toBeNull();
  });

  it('returns null when stream chunk has no candidates', () => {
    const chunk = provider.parseStreamChunk({ data: JSON.stringify({}) });
    expect(chunk).toBeNull();
  });

  it('captures usage from a candidate-less chunk that carries usageMetadata', () => {
    // A trailing usage-only chunk (no candidate) must not drop usage — otherwise
    // extractUsage falls back to char/4 with input_tokens=0 (under-billing).
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({ usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 7, totalTokenCount: 27 } }),
    });
    expect(chunk).toEqual({
      type: 'usage',
      usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27, cache_read_tokens: 0 },
    });
  });

  it('maps unknown finish reasons to end', () => {
    const chunk = provider.parseStreamChunk({
      data: JSON.stringify({ candidates: [{ finishReason: 'SOMETHING_ELSE' }] }),
    });
    expect(chunk).toEqual({ type: 'done', stop_reason: 'end' });
  });
});
