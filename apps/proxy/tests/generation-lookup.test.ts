import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockValidate = vi.fn();
vi.mock('../src/db/pool.js', () => ({ getPool: () => ({ query: mockQuery }) }));
vi.mock('../src/auth/api-key.js', () => ({ validateApiKey: (k: string) => mockValidate(k) }));

import { handleGenerationLookup } from '../src/usage/generation-lookup.js';

function makeRes() {
  let statusCode = 0; let body = ''; const headers: Record<string, string> = {};
  const res = {
    setHeader(k: string, v: string) { headers[k] = v; },
    writeHead(c: number, h?: Record<string, string>) { statusCode = c; Object.assign(headers, h ?? {}); return this; },
    end(chunk?: string) { body = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  return { res, get statusCode() { return statusCode; }, get body() { return body; } };
}

const KEY = { authorization: 'Bearer sk-proxy-team-a' };

beforeEach(() => { mockQuery.mockReset(); mockValidate.mockReset(); mockValidate.mockResolvedValue({ teamId: 'team_a' }); });

function row() {
  return {
    id: 'req_1', model_resolved: 'gpt-5.4', provider: 'azure', timestamp: '2026-06-01T00:00:00.000Z',
    input_tokens: 100, output_tokens: 20, actual_cost_microcents: 1_240_000, plugin_cost_microcents: 500_000,
    total_latency_ms: 1800, ttft_ms: 160, is_streaming: false,
  };
}

it('401s without a key', async () => {
  const out = makeRes();
  await handleGenerationLookup({ headers: {}, url: '/api/v1/generation?id=req_1' } as IncomingMessage, out.res);
  expect(out.statusCode).toBe(401);
  expect(mockValidate).not.toHaveBeenCalled();
  expect(mockQuery).not.toHaveBeenCalled();
});

it('401s invalid keys before any query', async () => {
  mockValidate.mockResolvedValue(null);
  const out = makeRes();
  await handleGenerationLookup({ headers: KEY, url: '/api/v1/generation?id=req_1' } as unknown as IncomingMessage, out.res);
  expect(out.statusCode).toBe(401);
  expect(mockQuery).not.toHaveBeenCalled();
});

it('403s a scoped key that lacks read before any storage query', async () => {
  mockValidate.mockResolvedValue({ teamId: 'team_a', metadata: { scope: 'inference' } });
  const out = makeRes();
  await handleGenerationLookup({ headers: KEY, url: '/api/v1/generation?id=req_1' } as unknown as IncomingMessage, out.res);
  expect(out.statusCode).toBe(403);
  expect(JSON.parse(out.body)).toEqual({
    error: { message: 'insufficient_scope: missing read scope', code: 'insufficient_scope' },
  });
  expect(mockQuery).not.toHaveBeenCalled();
});

it('allows an unscoped key to read a generation', async () => {
  mockValidate.mockResolvedValue({ teamId: 'team_a', metadata: {} });
  mockQuery.mockResolvedValue({ rows: [row()] });
  const out = makeRes();
  await handleGenerationLookup({ headers: KEY, url: '/api/v1/generation?id=req_1' } as unknown as IncomingMessage, out.res);
  expect(out.statusCode).toBe(200);
});

it('allows a key scoped with read to read a generation', async () => {
  mockValidate.mockResolvedValue({ teamId: 'team_a', metadata: { scope: 'read' } });
  mockQuery.mockResolvedValue({ rows: [row()] });
  const out = makeRes();
  await handleGenerationLookup({ headers: KEY, url: '/api/v1/generation?id=req_1' } as unknown as IncomingMessage, out.res);
  expect(out.statusCode).toBe(200);
});

it('returns the row for the owning team', async () => {
  mockQuery.mockResolvedValue({ rows: [row()] });
  const out = makeRes();
  await handleGenerationLookup({ headers: KEY, url: '/api/v1/generation?id=req_1' } as unknown as IncomingMessage, out.res);
  expect(out.statusCode).toBe(200);
  const data = JSON.parse(out.body).data;
  expect(data.id).toBe('req_1');
  expect(data.total_cost).toBeCloseTo(0.0174, 6);
  expect(mockQuery.mock.calls[0][0]).toContain('plugin_cost_microcents');
  const sql = mockQuery.mock.calls[0][0] as string;
  const params = mockQuery.mock.calls[0][1] as string[];
  expect(sql).toMatch(/team_id\s*=\s*\$2/i);
  expect(params).toEqual(['req_1', 'team_a']);
});

it('clamps generation_time to 0 when ttft_ms exceeds total latency', async () => {
  mockQuery.mockResolvedValue({ rows: [{
    id: 'req_1', model_resolved: 'gpt-5.4', provider: 'azure', timestamp: '2026-06-01T00:00:00.000Z',
    input_tokens: 100, output_tokens: 20, actual_cost_microcents: 1_240_000, total_latency_ms: 100, ttft_ms: 250, is_streaming: true,
  }] });
  const out = makeRes();
  await handleGenerationLookup({ headers: KEY, url: '/api/v1/generation?id=req_1' } as unknown as IncomingMessage, out.res);
  expect(out.statusCode).toBe(200);
  expect(JSON.parse(out.body).data.generation_time).toBe(0);
});

it('returns null for cancellation/cache fields because request_logs does not track them', async () => {
  mockQuery.mockResolvedValue({ rows: [{
    id: 'req_1', model_resolved: 'gpt-5.4', provider: 'azure', timestamp: '2026-06-01T00:00:00.000Z',
    input_tokens: 100, output_tokens: 20, actual_cost_microcents: 1_240_000, total_latency_ms: 1800, ttft_ms: 160, is_streaming: false,
    status_code: 499, cache_hit: true,
  }] });
  const out = makeRes();
  await handleGenerationLookup({ headers: KEY, url: '/api/v1/generation?id=req_1' } as unknown as IncomingMessage, out.res);

  expect(out.statusCode).toBe(200);
  const data = JSON.parse(out.body).data;
  expect(data.cancelled).toBeNull();
  expect(data.cache_discount).toBeNull();
  const sql = mockQuery.mock.calls[0][0] as string;
  expect(sql).not.toMatch(/\bcancelled\b|\bcache_discount\b/);
});

it('404s another team\'s id identically to an unknown id (no oracle)', async () => {
  mockQuery.mockResolvedValue({ rows: [] });
  const out = makeRes();
  await handleGenerationLookup({ headers: KEY, url: '/api/v1/generation?id=req_belongs_to_b' } as unknown as IncomingMessage, out.res);
  expect(out.statusCode).toBe(404);
  expect(JSON.parse(out.body).error.code).toBe('generation_not_found');
});
