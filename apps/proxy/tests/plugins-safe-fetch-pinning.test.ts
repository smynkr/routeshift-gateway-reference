import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { pinnedRequest, safeFetch, type HostLookup, type SafeFetchRequest } from '../src/plugins/safe-fetch.js';

interface ReceivedRequest {
  method: string | undefined;
  host: string | undefined;
  url: string | undefined;
}

describe('plugin safeFetch pinned requests', () => {
  it('pins the TCP connection to the supplied address while preserving the original host', async () => {
    let received: ReceivedRequest | null = null;
    const server = createServer((req, res) => {
      received = {
        method: req.method,
        host: req.headers.host,
        url: req.url,
      };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pinned-ok');
    });

    const port = await listen(server, '127.0.0.1');
    try {
      const url = new URL(`http://looks-public.example:${port}/path?pin=1`);
      const result = await pinnedRequest(url, '127.0.0.1', 4);

      expect(result.statusCode).toBe(200);
      expect(result.body.toString('utf8')).toBe('pinned-ok');
      expect(received).toEqual({
        method: 'GET',
        host: `looks-public.example:${port}`,
        url: '/path?pin=1',
      });
      console.info(
        `pinnedRequest local server received host=${received?.host} url=${received?.url} body=${result.body.toString('utf8')}`,
      );
    } finally {
      await close(server);
    }
  });

  it('rejects unsafe literal loopback URLs before lookup or connection', async () => {
    const lookup: HostLookup = async () => {
      throw new Error('lookup should not be called for unsafe literal URLs');
    };

    await expect(safeFetch('http://127.0.0.1/x', undefined, lookup)).rejects.toThrow('file_url_blocked');
  });

  it('rejects IPv4-translatable IPv6 private literals before lookup or connection', async () => {
    const lookup: HostLookup = async () => {
      throw new Error('lookup should not be called for unsafe literal URLs');
    };
    const request: SafeFetchRequest = vi.fn(async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(0),
    }));

    await expect(safeFetch('http://[::ffff:0:127.0.0.1]/x', undefined, lookup, request))
      .rejects.toThrow('file_url_blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not call the final request transport for a blocked localhost URL', async () => {
    const lookup = vi.fn<HostLookup>(async () => [{ address: '93.184.216.34', family: 4 }]);
    const request: SafeFetchRequest = vi.fn(async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(0),
    }));

    await expect(safeFetch('http://localhost/file.pdf', undefined, lookup, request))
      .rejects.toThrow('file_url_blocked');
    expect(lookup).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not call transport for an Alibaba metadata literal or a hostname resolving there', async () => {
    const request: SafeFetchRequest = vi.fn(async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(0),
    }));
    const lookup: HostLookup = vi.fn(async () => [{ address: '100.100.100.200', family: 4 }]);

    await expect(safeFetch('http://100.100.100.200/latest/meta-data', undefined, lookup, request))
      .rejects.toThrow('file_url_blocked');
    await expect(safeFetch('http://metadata.attacker.example/latest-meta-data', undefined, lookup, request))
      .rejects.toThrow('file_url_blocked');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a hostname that RESOLVES to an unsafe address, before ever connecting', async () => {
    const lookup: HostLookup = async () => [{ address: '169.254.169.254', family: 4 }];
    const lookupSpy = { calls: 0 };
    const spiedLookup: HostLookup = async (hostname) => {
      lookupSpy.calls += 1;
      return lookup(hostname);
    };

    await expect(safeFetch('http://attacker.example/x', undefined, spiedLookup)).rejects.toThrow(
      'file_url_blocked',
    );
    expect(lookupSpy.calls).toBe(1);
  });

  it('revalidates a redirect target before a second request, while preserving default no-redirect behavior', async () => {
    const lookup: HostLookup = vi.fn(async (hostname) => {
      if (hostname === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
      return [{ address: '169.254.169.254', family: 4 }];
    });
    const request: SafeFetchRequest = vi.fn(async () => ({
      statusCode: 302,
      headers: { location: 'http://metadata.example/latest/meta-data' },
      body: Buffer.alloc(0),
    }));

    const unchanged = await safeFetch('https://public.example/file.pdf', undefined, lookup, request);
    expect(unchanged.statusCode).toBe(302);
    expect(request).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);

    vi.mocked(request).mockClear();
    vi.mocked(lookup).mockClear();
    await expect(safeFetch(
      'https://public.example/file.pdf',
      { followRedirects: true, maxRedirects: 2 },
      lookup,
      request,
    )).rejects.toThrow('file_url_blocked');
    expect(request).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('public.example');
    expect(lookup).toHaveBeenCalledWith('metadata.example');
  });

  it('bounds the total redirect chain by the requested timeout, not one timeout per hop', async () => {
    const lookup: HostLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const request: SafeFetchRequest = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        statusCode: 302,
        headers: { location: 'https://also-public.example/file.pdf' },
        body: Buffer.alloc(0),
      };
    });

    await expect(safeFetch(
      'https://public.example/file.pdf',
      { followRedirects: true, timeoutMs: 5 },
      lookup,
      request,
    )).rejects.toThrow('file_fetch_timeout');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('bounds DNS resolution by the requested whole-request timeout before transport', async () => {
    const lookup: HostLookup = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [{ address: '93.184.216.34', family: 4 }];
    };
    const request: SafeFetchRequest = vi.fn(async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.alloc(0),
    }));

    await expect(safeFetch(
      'https://slow-dns.example/file.pdf',
      { timeoutMs: 5 },
      lookup,
      request,
    )).rejects.toThrow('file_fetch_timeout');
    expect(request).not.toHaveBeenCalled();
  });
  it('enforces the response byte cap at the safeFetch boundary for custom transports', async () => {
    const lookup: HostLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const request: SafeFetchRequest = vi.fn(async () => ({
      statusCode: 200,
      headers: {},
      body: Buffer.from('12345'),
    }));

    await expect(safeFetch(
      'https://public.example/file.pdf',
      { maxBytes: 4 },
      lookup,
      request,
    )).rejects.toThrow('file_too_large');
  });


  it('rejects a response above the requested byte cap before buffering it', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '5' });
      res.end('12345');
    });
    const port = await listen(server, '127.0.0.1');
    try {
      await expect(pinnedRequest(
        new URL(`http://looks-public.example:${port}/file.pdf`),
        '127.0.0.1',
        4,
        { maxBytes: 4 },
      )).rejects.toThrow('file_too_large');
    } finally {
      await close(server);
    }
  });

  it('enforces the byte cap for chunked responses without a content-length header', async () => {
    const server = createServer((_req, res) => {
      res.write('1234');
      res.end('5');
    });
    const port = await listen(server, '127.0.0.1');
    try {
      await expect(pinnedRequest(
        new URL(`http://looks-public.example:${port}/file.pdf`),
        '127.0.0.1',
        4,
        { maxBytes: 4 },
      )).rejects.toThrow('file_too_large');
    } finally {
      await close(server);
    }
  });

  it('aborts a slow response at the requested timeout', async () => {
    const server = createServer((_req, res) => {
      setTimeout(() => res.end('too late'), 100);
    });
    const port = await listen(server, '127.0.0.1');
    try {
      await expect(pinnedRequest(
        new URL(`http://looks-public.example:${port}/file.pdf`),
        '127.0.0.1',
        4,
        { timeoutMs: 10 },
      )).rejects.toThrow('file_fetch_timeout');
    } finally {
      await close(server);
    }
  });

  it('never reuses a pooled keep-alive socket across calls with different pins for the same host:port', async () => {
    // Regression: Node's http/https Agent keys its free-socket pool on
    // hostname:port only -- it has no knowledge of which address a pooled
    // socket actually connected to. Without `agent: false` in pinnedRequest,
    // a second call for the same nominal hostname:port could silently be
    // served by a stale socket from an earlier call whose pin has since
    // changed, defeating the whole point of pinning. Use IPv6 ::1 for one
    // server and IPv4 127.0.0.1 for the other -- both are universally
    // available loopback addresses (unlike a second IPv4 loopback alias,
    // which needs extra config on Linux) that can share the same port number
    // since they're different specific addresses.
    const serverV6 = createServer((_req, res) => res.end('served-by-v6'));
    const port = await listen(serverV6, '::1');
    const serverV4 = createServer((_req, res) => res.end('served-by-v4'));
    await listen(serverV4, '127.0.0.1', port);

    try {
      const url = new URL(`http://reuse-test.example:${port}/x`);
      const first = await pinnedRequest(url, '::1', 6);
      expect(first.body.toString('utf8')).toBe('served-by-v6');

      // Same nominal hostname:port as the first call (so Node's Agent pool
      // key collides) but pinned to a DIFFERENT address this time. With
      // `agent: false` this opens a fresh socket to the new pin; without it,
      // Node could silently reuse the pooled socket still connected to ::1.
      const second = await pinnedRequest(url, '127.0.0.1', 4);
      expect(second.body.toString('utf8')).toBe('served-by-v4');
    } finally {
      await close(serverV6);
      await close(serverV4);
    }
  });
});

async function listen(server: Server, host: string, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }
  return (address as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
