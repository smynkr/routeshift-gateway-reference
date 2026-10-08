import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { handleCatalogManifest, handleModelDetail } from './handlers.js';
import { createProxyServer } from '../server.js';

function mockReq(url?: string) {
  return { url, headers: {}, method: 'GET' } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 0,
    headers: undefined as Record<string, string> | undefined,
    body: '',
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
    },
  };
  return res;
}

function getJson(port: number, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('handleModelDetail', () => {
  it('does not require req.url for direct model detail lookups', async () => {
    const res = mockRes();

    await handleModelDetail(mockReq(), res, 'gpt-5.5');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('gpt-5.5');
  });
});

describe('docs catalog manifest', () => {
  it('serves the public manifest without authentication and with bounded caching', async () => {
    const res = mockRes();

    await handleCatalogManifest(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    });
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      schema_version: 1,
      generated_at: expect.any(String),
      source_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      recommendations: expect.objectContaining({ default: expect.any(String) }),
    });
    expect(body.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gpt-5.6', routing: 'explicit_only' }),
    ]));
  });
});

describe('docs catalog manifest route', () => {
  it('matches the exact manifest path before model detail dispatch', async () => {
    const app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');

    try {
      const res = await getJson(address.port, '/v1/models/catalog-manifest');

      expect(res.status).toBe(200);
      expect(res.body.schema_version).toBe(1);
      expect(res.body.models).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'gpt-5.6' }),
      ]));
    } finally {
      await app.stop();
    }
  });

  it('returns 404 for paths below the exact manifest route', async () => {
    const app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');

    try {
      const res = await getJson(address.port, '/v1/models/catalog-manifest/extra');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: 'Not found' } });
    } finally {
      await app.stop();
    }
  });
});

describe('model detail route', () => {
  it('allows a well-formed /v1/models/:id detail path', async () => {
    const app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');

    try {
      const res = await getJson(address.port, '/v1/models/gpt-5.5');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('gpt-5.5');
    } finally {
      await app.stop();
    }
  });

  it('rejects deeper /v1/models/:id paths instead of treating the first segment as a model id', async () => {
    const app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');

    try {
      const res = await getJson(address.port, '/v1/models/gpt-5.5/extra');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: { message: 'Not found' } });
    } finally {
      await app.stop();
    }
  });
  it('decodes one URL segment so encoded Bedrock colons resolve', async () => {
    const app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');

    try {
      const res = await getJson(address.port, '/v1/models/anthropic.claude-3-5-haiku-20241022-v1%3A0');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('anthropic.claude-3-5-haiku-20241022-v1:0');
    } finally {
      await app.stop();
    }
  });

  it('decodes an encoded slash so the Cloudflare model detail is addressable', async () => {
    const app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');

    try {
      const modelId = encodeURIComponent('@cf/zai-org/glm-5.3-flash');
      const res = await getJson(address.port, `/v1/models/${modelId}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('@cf/zai-org/glm-5.3-flash');
    } finally {
      await app.stop();
    }
  });
  it('returns 400 for a malformed encoded model id instead of throwing', async () => {
    const app = createProxyServer(0);
    await app.start();
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');

    try {
      const res = await getJson(address.port, '/v1/models/%E0%A4%A');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: { message: 'Invalid model id encoding', code: 'invalid_model_id_encoding' },
      });
    } finally {
      await app.stop();
    }
  });
});
