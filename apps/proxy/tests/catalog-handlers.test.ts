import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockValidate = vi.fn();
vi.mock('../src/auth/api-key.js', () => ({ validateApiKey: (k: string) => mockValidate(k) }));

import { handleCatalogManifest, handleModelsList, handleModelDetail } from '../src/catalog/handlers.js';

function makeRes() {
  let statusCode = 0; let body = ''; const headers: Record<string, string> = {};
  const res = {
    setHeader(k: string, v: string) { headers[k] = v; },
    writeHead(code: number, h?: Record<string, string>) { statusCode = code; Object.assign(headers, h ?? {}); return this; },
    end(chunk?: string) { body = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  return { res, get statusCode() { return statusCode; }, get body() { return body; }, get headers() { return headers; } };
}

describe('handleModelsList', () => {
  beforeEach(() => mockValidate.mockReset());
  it('returns full catalog when unauthenticated', async () => {
    const req = { headers: {} } as IncomingMessage;
    const out = makeRes();
    await handleModelsList(req, out.res);
    expect(out.statusCode).toBe(200);
    const body = JSON.parse(out.body);
    expect(body.object).toBe('list');
    expect(body.data.map((m: any) => m.id)).toContain('text-embedding-3-small');
    expect(mockValidate).not.toHaveBeenCalled();
  });
  it('filters by allowedModels when a valid key is present', async () => {
    mockValidate.mockResolvedValue({ teamId: 't1', allowedModels: ['gpt-5.4'] });
    const req = { headers: { authorization: 'Bearer sk-proxy-abc' } } as unknown as IncomingMessage;
    const out = makeRes();
    await handleModelsList(req, out.res);
    expect(JSON.parse(out.body).data.map((m: any) => m.id)).toEqual(['gpt-5.4']);
  });
  it('filters embedding models by allowedModels when a valid key is present', async () => {
    mockValidate.mockResolvedValue({ teamId: 't1', allowedModels: ['text-embedding-3-small'] });
    const req = { headers: { authorization: 'Bearer sk-proxy-abc' } } as unknown as IncomingMessage;
    const out = makeRes();
    await handleModelsList(req, out.res);
    expect(JSON.parse(out.body).data.map((m: any) => m.id)).toEqual(['text-embedding-3-small']);
  });
  it('ignores an invalid key (never 401s the public list)', async () => {
    mockValidate.mockResolvedValue(null);
    const req = { headers: { authorization: 'Bearer sk-proxy-bad' } } as unknown as IncomingMessage;
    const out = makeRes();
    await handleModelsList(req, out.res);
    expect(out.statusCode).toBe(200);
    expect(JSON.parse(out.body).data.length).toBeGreaterThan(1);
  });
});

describe('handleCatalogManifest', () => {
  beforeEach(() => mockValidate.mockReset());
  it('returns only the unauthenticated public docs contract', async () => {
    const req = { headers: { authorization: 'Bearer sk-proxy-should-not-be-used' } } as unknown as IncomingMessage;
    const out = makeRes();

    await handleCatalogManifest(req, out.res);

    expect(out.statusCode).toBe(200);
    expect(out.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    });
    const body = JSON.parse(out.body);
    expect(Object.keys(body).sort()).toEqual([
      'generated_at',
      'models',
      'recommendations',
      'schema_version',
      'source_hash',
    ]);
    expect(body.models.every((model: Record<string, unknown>) => (
      Object.keys(model).sort().join(',') === 'context_length,id,pricing,provenance,provider,routing'
    ))).toBe(true);
    expect(mockValidate).not.toHaveBeenCalled();
  });
});

describe('handleModelDetail', () => {
  beforeEach(() => mockValidate.mockReset());
  it('returns embedding model details', async () => {
    for (const id of ['text-embedding-3-small', 'text-embedding-004']) {
      const req = { headers: {} } as IncomingMessage;
      const out = makeRes();
      await handleModelDetail(req, out.res, id);
      expect(out.statusCode).toBe(200);
      const body = JSON.parse(out.body);
      expect(body.id).toBe(id);
      expect(body.architecture.output_modalities).toEqual(['embedding']);
    }
  });
  it('404s unknown id with model_not_found', async () => {
    const req = { headers: {} } as IncomingMessage;
    const out = makeRes();
    await handleModelDetail(req, out.res, 'nope');
    expect(out.statusCode).toBe(404);
    expect(JSON.parse(out.body).error.code).toBe('model_not_found');
  });
});
