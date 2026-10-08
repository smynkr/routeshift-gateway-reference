import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { collectPluginSpecs } from '../src/plugins/specs.js';
import {
  assertSafeHttpUrl,
  FileFetchTimeoutError,
  FileTooLargeError,
  FileUrlBlockedError,
  resolveAndAssertSafeHttpUrl,
} from '../src/plugins/safe-fetch.js';
import { augmentWithFileParser } from '../src/plugins/file-parser.js';
import { augmentWithWebSearch, buildUntrustedWebSearchEnvelope } from '../src/plugins/web-search.js';
import { estimatePluginSurchargeMicrocents, PluginRequiredError, runPlugins } from '../src/plugins/runtime.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';

describe('plugin request specs', () => {
  it('puts mocked search results in a bounded untrusted user envelope for every provider adapter', async () => {
    const originalFetch = globalThis.fetch;
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.SEARCH_BACKEND = 'exa';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ results: [{ title: 'Launch', url: 'https://example.com/launch', highlights: ['RouteShift ships safely'] }] }), { status: 200 })) as typeof fetch;
    const result = await augmentWithWebSearch({
      model: 'gpt-5.4',
      system_prompt: 'Privileged policy',
      messages: [{ role: 'user', content: 'launch news' }],
      stream: false,
    }, { id: 'web' });
    expect(result.system_prompt).toBe('Privileged policy');
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ role: 'user' });
    expect(result.messages[1]?.content).toContain('untrusted_web_search_results');
    expect(result.messages[1]?.content).toContain('RouteShift ships safely');

    const openaiBody = JSON.parse(new OpenAIProvider().buildRequest(result, 'provider-key').body);
    expect(openaiBody.messages).toEqual([
      { role: 'system', content: 'Privileged policy' },
      { role: 'user', content: 'launch news' },
      expect.objectContaining({ role: 'user' }),
    ]);
    expect(openaiBody.messages[2].content).toContain('untrusted_web_search_results');

    const anthropicBody = JSON.parse(new AnthropicProvider().buildRequest(result, 'provider-key').body);
    expect(anthropicBody.system).toBe('Privileged policy');
    expect(anthropicBody.messages).toEqual([
      { role: 'user', content: 'launch news' },
      expect.objectContaining({ role: 'user' }),
    ]);
    expect(anthropicBody.messages[1].content).toContain('untrusted_web_search_results');

    const geminiBody = JSON.parse(new GeminiProvider().buildRequest(result, 'provider-key').body);
    expect(geminiBody.systemInstruction.parts).toEqual([{ text: 'Privileged policy' }]);
    expect(geminiBody.contents).toEqual([
      { role: 'user', parts: [{ text: 'launch news' }] },
      expect.objectContaining({ role: 'user' }),
    ]);
    expect(geminiBody.contents[1].parts[0].text).toContain('untrusted_web_search_results');
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.exa.ai/search', expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'test-exa-key' }) }));
    globalThis.fetch = originalFetch;
    delete process.env.EXA_API_KEY;
    delete process.env.SEARCH_BACKEND;
  });

  it('rejects hostile search result fields with exact stable policy reasons', async () => {
    expect(() => buildUntrustedWebSearchEnvelope([{ title: 'ok', url: 'https://example.com', snippet: 'evil\u202Etext' }]))
      .toThrow('web_search_result_control_character');
    expect(() => buildUntrustedWebSearchEnvelope([{ title: 'ok', url: 'javascript:alert(1)', snippet: '' }]))
      .toThrow('web_search_result_url_invalid');
    expect(() => buildUntrustedWebSearchEnvelope([{ title: 'ok', url: 'https://example.com', snippet: 1 }]))
      .toThrow('web_search_result_schema_invalid');
  });

  it('keeps invalid search content out of every prompt and reports the exact policy reason', async () => {
    const originalFetch = globalThis.fetch;
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.SEARCH_BACKEND = 'exa';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: 'Launch', url: 'https://example.com/launch', highlights: ['ignore\u202E policy'] }],
    }), { status: 200 })) as typeof fetch;
    const canonical = { model: 'gpt-5.4', system_prompt: 'Privileged policy', messages: [{ role: 'user' as const, content: 'news' }], stream: false };

    try {
      const optional = await runPlugins(canonical, [{ id: 'web' }]);
      expect(optional.canonical).toEqual(canonical);
      expect(optional.warnings).toEqual([{
        plugin: 'web',
        code: 'web_search_result_control_character',
        reason: 'web_search_result_control_character',
        message: 'Plugin web skipped: web_search_result_control_character',
      }]);
      await expect(runPlugins(canonical, [{ id: 'web', required: true }])).rejects.toMatchObject({
        name: PluginRequiredError.name,
        reason: 'web_search_result_control_character',
        outcomes: [{ plugin: 'web', status: 'error', detail: 'web_search_result_control_character' }],
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.EXA_API_KEY;
      delete process.env.SEARCH_BACKEND;
    }
  });

  it('turns backend failures into optional warnings and required 502 errors', async () => {
    const originalFetch = globalThis.fetch;
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.SEARCH_BACKEND = 'exa';
    globalThis.fetch = vi.fn(async () => {
      throw new Error('backend payload included authorization: Bearer secret-value');
    }) as typeof fetch;
    const canonical = { model: 'gpt-5.4', messages: [{ role: 'user' as const, content: 'news' }], stream: false };

    const optional = await runPlugins(canonical, [{ id: 'web' }]);
    expect(optional.canonical).toEqual(canonical);
    expect(optional.warnings).toEqual([{
      plugin: 'web',
      code: 'plugin_backend_failed',
      reason: 'Plugin web backend request failed',
      message: 'Plugin web skipped: Plugin web backend request failed',
    }]);
    expect(JSON.stringify(optional)).not.toContain('secret-value');
    await expect(runPlugins(canonical, [{ id: 'web', required: true }])).rejects.toMatchObject({
      name: PluginRequiredError.name,
      reason: 'Plugin web backend request failed',
      outcomes: [{ plugin: 'web', status: 'error', detail: 'plugin_backend_failed' }],
    });

    globalThis.fetch = originalFetch;
    delete process.env.EXA_API_KEY;
    delete process.env.SEARCH_BACKEND;
  });

  it('estimates the deterministic web surcharge before executing plugins', () => {
    const previous = process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
    process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = '321';
    try {
      expect(estimatePluginSurchargeMicrocents([{ id: 'web' }, { id: 'file-parser' }])).toBe(321);
    } finally {
      if (previous === undefined) delete process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
      else process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = previous;
    }
  });

  it('preserves sanitized outcomes and successful web surcharge on a later required file failure', async () => {
    const originalFetch = globalThis.fetch;
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.SEARCH_BACKEND = 'exa';
    process.env.WEB_SEARCH_SURCHARGE_MICROCENTS = '321';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: 'Launch', url: 'https://example.com/launch', highlights: ['RouteShift ships safely'] }],
    }), { status: 200 })) as typeof fetch;

    const canonical = {
      model: 'gpt-5.4',
      messages: [{
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'launch news' },
          { type: 'input_file', filename: 'report.pdf', file_data: 'not-a-pdf' },
        ],
      }],
      stream: false,
    };

    try {
      await runPlugins(canonical as any, [{ id: 'web' }, { id: 'file-parser', required: true }]);
      throw new Error('Expected required file-parser failure');
    } catch (error) {
      expect(error).toBeInstanceOf(PluginRequiredError);
      expect(error).toMatchObject({
        plugin: 'file-parser',
        reason: 'unsupported_file_type',
        surchargeMicrocents: 321,
        warnings: [],
        outcomes: [
          { plugin: 'web', status: 'ok', costMicrocents: 321 },
          { plugin: 'file-parser', status: 'error', costMicrocents: 0, detail: 'unsupported_file_type' },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.EXA_API_KEY;
      delete process.env.SEARCH_BACKEND;
      delete process.env.WEB_SEARCH_SURCHARGE_MICROCENTS;
    }
  });

  it('keeps untrusted web data in a user envelope when another plugin processes the request', async () => {
    const originalFetch = globalThis.fetch;
    process.env.EXA_API_KEY = 'test-exa-key';
    process.env.SEARCH_BACKEND = 'exa';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: 'Launch', url: 'https://example.com/launch', highlights: ['RouteShift ships safely'] }],
    }), { status: 200 })) as typeof fetch;

    try {
      const result = await runPlugins({
        model: 'gpt-5.4',
        system_prompt: [
          { type: 'text', text: 'Base policy', cache_control: { type: 'ephemeral' } },
          {
            type: 'input_file',
            filename: 'routeshift-file-parser-fixture.pdf',
            file_data: fixturePdfBase64(),
          },
        ],
        messages: [{ role: 'user', content: 'launch news' }],
        stream: false,
      }, [{ id: 'web' }, { id: 'file-parser' }], {
        providerId: 'openai',
        routedModel: 'gpt-5.4',
      });

      const system = JSON.stringify(result.canonical.system_prompt);
      expect(system).toContain('Base policy');
      expect(system).toContain('cache_control');
      const untrustedEnvelope = result.canonical.messages.at(-1);
      expect(untrustedEnvelope).toMatchObject({ role: 'user' });
      expect(untrustedEnvelope?.content).toContain('untrusted_web_search_results');
      expect(untrustedEnvelope?.content).toContain('RouteShift ships safely');
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.EXA_API_KEY;
      delete process.env.SEARCH_BACKEND;
    }
  });
  it('collects explicit web plugin options and strips :online from model', () => {
    const result = collectPluginSpecs({
      model: 'gpt-5.4:online',
      plugins: [{ id: 'web', required: true, max_results: 3, search_prompt: 'EU AI Act' }],
    });

    expect(result).toEqual({
      model: 'gpt-5.4',
      plugins: [{ id: 'web', required: true, max_results: 3, search_prompt: 'EU AI Act' }],
      errors: [],
      fileParserExplicit: false,
    });
  });

  it('treats :online as a default web plugin and lets explicit web options win', () => {
    const result = collectPluginSpecs({
      model: 'claude-opus-4-8:online',
      plugins: [{ id: 'web', max_results: 7 }],
    });

    expect(result.model).toBe('claude-opus-4-8');
    expect(result.plugins).toEqual([{ id: 'web', max_results: 7 }]);
  });

  it('adds file-parser implicitly for OpenAI-style file content parts', () => {
    const result = collectPluginSpecs({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{ type: 'input_file', filename: 'report.pdf', file_data: 'cGRm' }],
      }],
    });

    expect(result.plugins).toEqual([{ id: 'file-parser' }]);
    expect(result.fileParserExplicit).toBe(false);
  });

  it('adds file-parser implicitly for top-level system_prompt file content', () => {
    const result = collectPluginSpecs({
      model: 'gpt-5.4',
      system_prompt: [{ type: 'input_file', filename: 'policy.pdf', file_data: 'cGRm' }],
    });

    expect(result.plugins).toEqual([{ id: 'file-parser' }]);
    expect(result.fileParserExplicit).toBe(false);
  });

  it('adds file-parser implicitly for top-level system file content', () => {
    const result = collectPluginSpecs({
      model: 'gpt-5.4',
      system: [{ type: 'input_file', filename: 'policy.pdf', file_data: 'cGRm' }],
    });

    expect(result.plugins).toEqual([{ id: 'file-parser' }]);
    expect(result.fileParserExplicit).toBe(false);
  });

  it('records explicit file-parser intent without changing the plugin wire shape', () => {
    const result = collectPluginSpecs({
      model: 'claude-haiku-4-5',
      plugins: [{ id: 'file-parser' }],
      messages: [{
        role: 'user',
        content: [{ type: 'input_file', filename: 'report.pdf', file_data: 'cGRm' }],
      }],
    });

    expect(result.plugins).toEqual([{ id: 'file-parser' }]);
    expect(result.fileParserExplicit).toBe(true);
  });

  it('uses shared suffix parsing for stacked routing and online suffixes', () => {
    const result = collectPluginSpecs({ model: 'gpt-5.4:floor:online' });

    expect(result.model).toBe('gpt-5.4');
    expect(result.plugins).toEqual([{ id: 'web' }]);
    expect(result.errors).toEqual([]);
  });

  it('rejects unknown plugin ids rather than silently forwarding them', () => {
    const result = collectPluginSpecs({ model: 'gpt-5.4', plugins: [{ id: 'browser' }] });

    expect(result.errors).toEqual([{ code: 'invalid_plugin', message: 'Unsupported plugin id: browser' }]);
  });

  it('rejects non-array plugin fields instead of ignoring required plugins', () => {
    const result = collectPluginSpecs({ model: 'gpt-5.4', plugins: { id: 'web', required: true } });

    expect(result.errors).toEqual([{ code: 'invalid_plugin', message: 'plugins must be an array' }]);
    expect(result.plugins).toEqual([]);
  });
});

describe('file-parser plugin', () => {
  it('replaces a base64 PDF with extracted text before the OpenAI upstream request', async () => {
    const result = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{
          type: 'input_file',
          filename: 'routeshift-file-parser-fixture.pdf',
          file_data: `data:application/pdf;base64,${fixturePdfBase64()}`,
        }],
      }],
      stream: false,
    } as any);

    expect(result.warnings).toEqual([]);
    const upstream = new OpenAIProvider().buildRequest(result.canonical, 'provider-key');
    const parts = JSON.parse(upstream.body).messages[0].content;
    expect(parts).toEqual([{
      type: 'text',
      text: '[Extracted from routeshift-file-parser-fixture.pdf]\nRouteShift PDF fixture text',
    }]);
  });

  it('runs an explicitly requested file-parser through the plugin runtime', async () => {
    const result = await runPlugins({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{
          type: 'input_file',
          filename: 'routeshift-file-parser-fixture.pdf',
          file_data: `data:application/pdf;base64,${fixturePdfBase64()}`,
        }],
      }],
      stream: false,
    } as any, [{ id: 'file-parser' }]);

    expect(result.warnings).toEqual([]);
    expect((result.canonical.messages[0].content as Array<{ text?: string }>)[0].text)
      .toContain('RouteShift PDF fixture text');
  });

  it('preserves a validated PDF for an exact native-capable route, but extracts when explicitly requested', async () => {
    const canonical = {
      model: 'claude-haiku-4-5',
      messages: [{
        role: 'user' as const,
        content: [{
          type: 'input_file',
          filename: 'routeshift-file-parser-fixture.pdf',
          file_data: `data:application/pdf;base64,${fixturePdfBase64()}`,
        }],
      }],
      stream: false,
    } as any;

    const native = await runPlugins(canonical, [{ id: 'file-parser' }], {
      providerId: 'anthropic',
      routedModel: 'claude-haiku-4-5',
      fallbackCandidates: [],
    });
    expect(native.warnings).toEqual([]);
    expect(native.canonical.messages[0].content).toEqual([{
      type: 'pdf',
      pdf: {
        media_type: 'application/pdf',
        data: fixturePdfBase64(),
        filename: 'routeshift-file-parser-fixture.pdf',
      },
    }]);

    const forced = await runPlugins(canonical, [{ id: 'file-parser' }], {
      providerId: 'anthropic',
      routedModel: 'claude-haiku-4-5',
      fallbackCandidates: [],
      forceFileExtraction: true,
    });
    expect((forced.canonical.messages[0].content as Array<{ type: string }>)[0].type).toBe('text');
  });

  it('falls back to extraction when any fallback target lacks native PDF support', async () => {
    const result = await runPlugins({
      model: 'claude-haiku-4-5',
      messages: [{
        role: 'user',
        content: [{
          type: 'input_file',
          filename: 'routeshift-file-parser-fixture.pdf',
          file_data: fixturePdfBase64(),
        }],
      }],
      stream: false,
    } as any, [{ id: 'file-parser' }], {
      providerId: 'anthropic',
      routedModel: 'claude-haiku-4-5',
      fallbackCandidates: [{ provider: 'openai', model: 'gpt-5.4' }],
    });

    expect((result.canonical.messages[0].content as Array<{ type: string }>)[0].type).toBe('text');
  });

  it('bounds extracted text before it can reach a provider payload', async () => {
    const result = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{ type: 'input_file', filename: 'fixture.pdf', file_data: fixturePdfBase64() }],
      }],
      stream: false,
    } as any, { maxTextChars: 5 });

    expect(result.warnings).toEqual([{ code: 'file_too_large' }]);
    expect(result.canonical.messages[0].content).toEqual([]);
  });

  it('serializes concurrent PDF parses so module cache resets cannot corrupt another request', async () => {
    const canonical = {
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{ type: 'input_file', filename: 'fixture.pdf', file_data: fixturePdfBase64() }],
      }],
      stream: false,
    } as any;

    const [first, second] = await Promise.all([
      augmentWithFileParser(canonical),
      augmentWithFileParser(canonical),
    ]);

    expect(first.warnings).toEqual([]);
    expect(second.warnings).toEqual([]);
    expect(first.canonical.messages[0].content).toHaveLength(1);
    expect(second.canonical.messages[0].content).toHaveLength(1);
  });

  it('enforces one request-wide extraction budget across multiple PDF parts', async () => {
    const result = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'one.pdf', file_data: fixturePdfBase64() },
          { type: 'input_file', filename: 'two.pdf', file_data: fixturePdfBase64() },
        ],
      }],
      stream: false,
    } as any, { maxTotalTextChars: 30 });

    expect(result.warnings).toEqual([{ code: 'file_too_large' }]);
    expect(result.canonical.messages[0].content).toHaveLength(1);
  });

  it('fetches URL PDFs through the bounded redirect-aware file fetch contract', async () => {
    const fetchFile = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from(fixturePdfBase64(), 'base64'),
    }));
    const result = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{ type: 'input_file', filename: 'report.pdf', file_url: 'https://files.example/report.pdf' }],
      }],
      stream: false,
    } as any, { fetchFile, maxBytes: 100_000, timeoutMs: 17 } as any);

    expect(fetchFile).toHaveBeenCalledWith('https://files.example/report.pdf', {
      method: 'GET',
      followRedirects: true,
      maxRedirects: 3,
      maxBytes: 100_000,
      timeoutMs: 17,
    });
    expect(result.warnings).toEqual([]);
    expect((result.canonical.messages[0].content as Array<{ text?: string }>)[0].text)
      .toContain('RouteShift PDF fixture text');
  });

  it('parses a bounded PDF subarray without exposing its larger backing buffer to pdf.js', async () => {
    const fixture = Buffer.from(fixturePdfBase64(), 'base64');
    const storage = Buffer.alloc(fixture.byteLength + 32, 0x41);
    fixture.copy(storage, 16);
    const body = storage.subarray(16, 16 + fixture.byteLength);
    expect(body.byteOffset).toBeGreaterThan(0);
    expect(body.buffer.byteLength).toBeGreaterThan(body.byteLength);

    const fetchFile = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/pdf' },
      body,
    }));
    const result = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{ type: 'input_file', filename: 'subarray.pdf', file_url: 'https://files.example/subarray.pdf' }],
      }],
      stream: false,
    } as any, { fetchFile, maxBytes: 100_000 });

    expect(result.warnings).toEqual([]);
    expect((result.canonical.messages[0].content as Array<{ text?: string }>)[0].text)
      .toBe('[Extracted from subarray.pdf]\nRouteShift PDF fixture text');
  });

  it('exhausts file-attempt and byte budgets before fetching another URL', async () => {
    const invalidPdfResponse = {
      statusCode: 200,
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.from('not-a-pdf'),
    };
    const blockedByCount = vi.fn(async () => invalidPdfResponse);
    const tooManyFiles = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'one.pdf', file_url: 'https://files.example/one.pdf' },
          { type: 'input_file', filename: 'two.pdf', file_url: 'https://files.example/two.pdf' },
        ],
      }],
      stream: false,
    } as any, { fetchFile: blockedByCount, maxFiles: 1 });

    expect(blockedByCount).toHaveBeenCalledTimes(1);
    expect(tooManyFiles.warnings).toEqual([
      { code: 'unsupported_file_type' },
      { code: 'file_too_large' },
    ]);

    const fixture = Buffer.from(fixturePdfBase64(), 'base64');
    const blockedByBytes = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'application/pdf' },
      body: fixture,
    }));
    const tooManyBytes = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'one.pdf', file_url: 'https://files.example/one.pdf' },
          { type: 'input_file', filename: 'two.pdf', file_url: 'https://files.example/two.pdf' },
        ],
      }],
      stream: false,
    } as any, { fetchFile: blockedByBytes, maxTotalBytes: fixture.byteLength });

    expect(blockedByBytes).toHaveBeenCalledTimes(1);
    expect(tooManyBytes.warnings).toEqual([{ code: 'file_too_large' }]);

    const oversizedResponse = vi.fn(async () => {
      throw new FileTooLargeError();
    });
    const overCapTransfer = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'one.pdf', file_url: 'https://files.example/one.pdf' },
          { type: 'input_file', filename: 'two.pdf', file_url: 'https://files.example/two.pdf' },
        ],
      }],
      stream: false,
    } as any, { fetchFile: oversizedResponse, maxTotalBytes: 100 });

    expect(oversizedResponse).toHaveBeenCalledTimes(1);
    expect(overCapTransfer.warnings).toEqual([
      { code: 'file_too_large' },
      { code: 'file_too_large' },
    ]);

    const timedOutResponse = vi.fn(async () => {
      throw new FileFetchTimeoutError();
    });
    const stalledTransfer = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'one.pdf', file_url: 'https://files.example/one.pdf' },
          { type: 'input_file', filename: 'two.pdf', file_url: 'https://files.example/two.pdf' },
        ],
      }],
      stream: false,
    } as any, { fetchFile: timedOutResponse, maxTotalBytes: 100 });

    expect(timedOutResponse).toHaveBeenCalledTimes(1);
    expect(stalledTransfer.warnings).toEqual([
      { code: 'file_fetch_timeout' },
      { code: 'file_too_large' },
    ]);

    const blockedRedirect = vi.fn(async () => {
      throw new FileUrlBlockedError();
    });
    const redirectedToMetadata = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'one.pdf', file_url: 'https://files.example/one.pdf' },
          { type: 'input_file', filename: 'two.pdf', file_url: 'https://files.example/two.pdf' },
        ],
      }],
      stream: false,
    } as any, { fetchFile: blockedRedirect, maxTotalBytes: 100 });

    expect(blockedRedirect).toHaveBeenCalledTimes(1);
    expect(redirectedToMetadata.warnings).toEqual([
      { code: 'file_url_blocked' },
      { code: 'file_too_large' },
    ]);
  });

  it('warns and strips an oversized optional file, but retains a required failure for the caller', async () => {
    const previousMaxBytes = process.env.PLUGIN_MAX_FILE_BYTES;
    process.env.PLUGIN_MAX_FILE_BYTES = '4';
    const canonical = {
      model: 'gpt-5.4',
      messages: [{
        role: 'user' as const,
        content: [{
          type: 'input_file',
          filename: 'too-large.pdf',
          file_data: Buffer.alloc(5, 1).toString('base64'),
        }],
      }],
      stream: false,
    };
    try {
      const optional = await runPlugins(canonical as any, [{ id: 'file-parser' }]);

      expect(optional.warnings).toEqual([{
        plugin: 'file-parser',
        code: 'file_too_large',
        reason: 'file_too_large',
        message: 'Plugin file-parser skipped: file_too_large',
      }]);
      expect(optional.canonical.messages[0].content).toEqual([]);

      await expect(runPlugins(canonical as any, [{ id: 'file-parser', required: true }]))
        .rejects.toMatchObject({
          plugin: 'file-parser',
          reason: 'file_too_large',
          outcomes: [{ plugin: 'file-parser', status: 'error', detail: 'file_too_large' }],
        });
    } finally {
      if (previousMaxBytes === undefined) delete process.env.PLUGIN_MAX_FILE_BYTES;
      else process.env.PLUGIN_MAX_FILE_BYTES = previousMaxBytes;
    }
  });

  it('keeps an optional blocked file URL out of the upstream canonical request and warnings', async () => {
    const blockedUrl = 'http://localhost/latest/meta-data';
    const result = await runPlugins({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{ type: 'input_file', filename: 'metadata.pdf', file_url: blockedUrl }],
      }],
      stream: false,
    } as any, [{ id: 'file-parser' }]);

    expect(result.warnings).toEqual([{
      plugin: 'file-parser',
      code: 'file_url_blocked',
      reason: 'file_url_blocked',
      message: 'Plugin file-parser skipped: file_url_blocked',
    }]);
    expect(JSON.stringify(result.warnings)).not.toContain(blockedUrl);
    expect(result.canonical.messages[0].content).toEqual([]);
  });

  it('drops URL content that is not served as application/pdf with a sanitized warning', async () => {
    const result = await augmentWithFileParser({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{ type: 'input_file', filename: 'not-a-pdf', file_url: 'https://files.example/report' }],
      }],
      stream: false,
    } as any, {
      fetchFile: async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<p>not a PDF</p>'),
      }),
    });

    expect(result.warnings).toEqual([{ code: 'unsupported_file_type' }]);
    expect(result.canonical.messages[0].content).toEqual([]);
  });
});

describe('plugin safeFetch URL guard', () => {
  it('allows public http and https URLs', () => {
    expect(() => assertSafeHttpUrl('https://example.com/file.pdf')).not.toThrow();
    expect(() => assertSafeHttpUrl('http://example.com/file.pdf')).not.toThrow();
  });

  it('blocks localhost, RFC1918, link-local metadata, and non-http schemes before fetch', () => {
    for (const url of [
      'http://localhost/file.pdf',
      'http://127.0.0.1/file.pdf',
      'http://10.0.0.1/file.pdf',
      'http://100.64.0.1/file.pdf',
      'http://100.100.100.200/latest/meta-data',
      'http://172.16.0.1/file.pdf',
      'http://192.168.1.1/file.pdf',
      'http://192.0.2.1/file.pdf',
      'http://198.18.0.1/file.pdf',
      'http://224.0.0.1/file.pdf',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/file.pdf',
      'http://[::ffff:127.0.0.1]/file.pdf',
      // IPv4-compatible IPv6 literals are normalized by URL parsing to hex
      // (for example ::127.0.0.1 -> ::7f00:1), so both spellings need a
      // regression guard rather than only the common mapped form above.
      'http://[::127.0.0.1]/file.pdf',
      'http://[::7f00:1]/file.pdf',
      'http://[::c0a8:101]/file.pdf',
      'http://[::ffff:0:127.0.0.1]/file.pdf',
      'http://[::ffff:0:10.0.0.1]/file.pdf',
      'http://[fc00::1]/file.pdf',
      'http://[fd00::1]/file.pdf',
      'http://[fe80::1]/file.pdf',
      // RSH-60: the whole link-local range is fe80::/10 (fe80:..febf:), not just
      // the four exact prefixes that were checked.
      'http://[fe8a::1]/file.pdf',
      'http://[feb5::1]/file.pdf',
      'http://[febf::1]/file.pdf',
      'http://[fec0::1]/file.pdf',
      'http://[feff::1]/file.pdf',
      'http://[ff02::1]/file.pdf',
      'http://[100::]/file.pdf',
      // RFC 6052's well-known NAT64 prefix must not smuggle an IPv4 metadata
      // target, and RFC 8215's local-use prefix is always deployment-local.
      'http://[64:ff9b::a9fe:a9fe]/file.pdf',
      'http://[64:ff9b:1:a9fe:a9:fe00::]/file.pdf',
      'file:///etc/passwd',
    ]) {
      expect(() => assertSafeHttpUrl(url)).toThrow('file_url_blocked');
    }
    expect(() => assertSafeHttpUrl('http://[64:ff9b::808:808]/file.pdf')).not.toThrow();
  });

  it('blocks hostnames that resolve to private or metadata addresses before fetch', async () => {
    const lookup = vi.fn(async () => [{ address: '169.254.169.254', family: 4 }]);

    await expect(resolveAndAssertSafeHttpUrl('https://attacker.example/file.pdf', lookup)).rejects.toThrow('file_url_blocked');
    expect(lookup).toHaveBeenCalledWith('attacker.example');
  });

  it('blocks hostnames that resolve to shared-address or cloud-metadata space before fetch', async () => {
    const lookup = vi.fn(async () => [{ address: '100.100.100.200', family: 4 }]);

    await expect(resolveAndAssertSafeHttpUrl('https://metadata.attacker.example/file.pdf', lookup))
      .rejects.toThrow('file_url_blocked');
    expect(lookup).toHaveBeenCalledWith('metadata.attacker.example');
  });
});

function fixturePdfBase64(): string {
  return readFileSync(new URL('./fixtures/routeshift-file-parser.pdf.base64', import.meta.url), 'utf8').trim();
}
