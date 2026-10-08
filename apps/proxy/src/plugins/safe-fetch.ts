import { lookup as dnsLookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';

export class FileUrlBlockedError extends Error {
  constructor(message = 'file_url_blocked') {
    super(message);
    this.name = 'FileUrlBlockedError';
  }
}

export class FileFetchFailedError extends Error {
  constructor(message = 'file_fetch_failed') {
    super(message);
    this.name = 'FileFetchFailedError';
  }
}

export class FileTooLargeError extends Error {
  constructor(message = 'file_too_large') {
    super(message);
    this.name = 'FileTooLargeError';
  }
}

export class FileFetchTimeoutError extends Error {
  constructor(message = 'file_fetch_timeout') {
    super(message);
    this.name = 'FileFetchTimeoutError';
  }
}

export type HostLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Disabled by default so existing callers keep receiving 3xx responses. */
  followRedirects?: boolean;
  /** Applied only when redirect following is explicitly enabled. */
  maxRedirects?: number;
  /** Optional whole-request deadline in milliseconds. */
  timeoutMs?: number;
  /** Optional response-body byte cap, enforced before buffering. */
  maxBytes?: number;
}

export interface SafeFetchResult {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type SafeFetchRequest = (
  url: URL,
  address: string,
  family: 4 | 6,
  init?: SafeFetchInit,
) => Promise<SafeFetchResult>;

type PinnedRequestOptions = http.RequestOptions & { servername?: string };

export function assertSafeHttpUrl(rawUrl: string): URL {
  const url = parseHttpUrl(rawUrl);
  assertSafeHost(url.hostname);
  return url;
}

export async function resolveAndAssertSafeHttpUrl(
  rawUrl: string,
  lookup: HostLookup = defaultLookup,
): Promise<URL> {
  const { url } = await resolveAndAssertSafeHttpUrlWithAddresses(rawUrl, lookup);
  return url;
}

export async function safeFetch(
  rawUrl: string,
  init?: SafeFetchInit,
  lookup: HostLookup = defaultLookup,
  request: SafeFetchRequest = pinnedRequest,
): Promise<SafeFetchResult> {
  let nextUrl = rawUrl;
  let redirects = 0;
  const maxRedirects = nonNegativeInt(init?.maxRedirects, 3);
  const timeoutMs = positiveTimeout(init?.timeoutMs);
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;

  while (true) {
    // Validate and pin every hop independently. A pre-flight check of only
    // the first URL is insufficient because a public URL can 3xx to metadata.
    const { url, addresses } = await awaitWithinDeadline(
      resolveAndAssertSafeHttpUrlWithAddresses(nextUrl, lookup),
      deadline,
    );
    const firstAddress = addresses[0];
    if (!firstAddress) throw new FileUrlBlockedError();
    const requestInit = remainingTimeoutInit(init, deadline);
    const result = await request(url, firstAddress.address, normalizeAddressFamily(firstAddress), requestInit);
    const maxBytes = byteCap(init?.maxBytes);
    if (maxBytes !== undefined && result.body.byteLength > maxBytes) {
      throw new FileTooLargeError();
    }
    if (deadline !== undefined && Date.now() >= deadline) throw new FileFetchTimeoutError();
    const location = redirectLocation(result);
    if (!init?.followRedirects || !location) return result;
    if (redirects >= maxRedirects) throw new FileFetchFailedError();

    try {
      nextUrl = new URL(location, url).toString();
    } catch {
      throw new FileUrlBlockedError();
    }
    redirects += 1;
  }
}

function remainingTimeoutInit(init: SafeFetchInit | undefined, deadline: number | undefined): SafeFetchInit | undefined {
  if (deadline === undefined) return init;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new FileFetchTimeoutError();
  return { ...init, timeoutMs: remaining };
}

/**
 * DNS lookups are user-controlled work just like the eventual HTTP request.
 * `dns.lookup()` has no AbortSignal in the Node versions we support, so the
 * lookup can continue in the background after this request returns, but the
 * caller must never wait beyond the configured whole-request deadline.
 */
function awaitWithinDeadline<T>(promise: Promise<T>, deadline: number | undefined): Promise<T> {
  if (deadline === undefined) return promise;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new FileFetchTimeoutError());

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new FileFetchTimeoutError()), remaining);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function redirectLocation(result: SafeFetchResult): string | undefined {
  if (![301, 302, 303, 307, 308].includes(result.statusCode)) return undefined;
  const location = result.headers.location;
  return Array.isArray(location) ? location[0] : location;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

// @internal — `address` MUST already be validated by the caller (assertSafeHost
// via resolveAndAssertSafeHttpUrl). This function performs NO validation of its
// own; calling it with an unvalidated address defeats the entire SSRF guard.
// Always go through `safeFetch` unless you are the validated call site inside
// this module or a test exercising this primitive directly.
export async function pinnedRequest(
  url: URL,
  address: string,
  family: 4 | 6,
  init: SafeFetchInit = {},
): Promise<SafeFetchResult> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FileUrlBlockedError();

  const client = url.protocol === 'https:' ? https : http;
  const requestOptions: PinnedRequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? 'GET',
    headers: init.headers,
    // Never reuse a pooled keep-alive socket: Node's Agent keys its free-socket
    // pool on hostname:port:family only, with no knowledge of which address a
    // pooled socket actually connected to. Without this, a second call for the
    // same nominal hostname:port can be silently served by a stale socket from
    // an earlier call whose pin has since changed — reintroducing exactly the
    // "validated address != connected address" gap this function exists to
    // close, just relocated from within-a-call to across-calls.
    agent: false,
    // Node's http/https core calls this with `options.all` sometimes true
    // (expects `(err, addresses[])`) and sometimes false/absent (expects
    // `(err, address, family)`) depending on internal version/path — handle
    // both so the pin isn't silently dropped by a mismatched callback shape.
    lookup: (_hostname, options, callback) => {
      if (typeof options === 'object' && options !== null && (options as { all?: boolean }).all) {
        (callback as (err: Error | null, addresses: Array<{ address: string; family: number }>) => void)(
          null,
          [{ address, family }],
        );
      } else {
        (callback as (err: Error | null, address: string, family: number) => void)(null, address, family);
      }
    },
  };

  if (url.protocol === 'https:') {
    requestOptions.servername = stripIpv6Brackets(url.hostname);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(error);
    };
    const resolveOnce = (result: SafeFetchResult) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(result);
    };
    const maxBytes = byteCap(init.maxBytes);
    const req = client.request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let byteLength = 0;
      res.on('error', rejectOnce);
      if (maxBytes !== undefined && advertisedContentLengthExceeds(res.headers, maxBytes)) {
        const error = new FileTooLargeError();
        res.resume();
        req.destroy(error);
        rejectOnce(error);
        return;
      }
      res.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += buffer.byteLength;
        if (maxBytes !== undefined && byteLength > maxBytes) {
          const error = new FileTooLargeError();
          res.destroy(error);
          req.destroy(error);
          rejectOnce(error);
          return;
        }
        chunks.push(buffer);
      });
      res.on('end', () => {
        if (settled) return;
        resolveOnce({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', rejectOnce);
    const timeoutMs = positiveTimeout(init.timeoutMs);
    if (timeoutMs !== undefined) {
      deadline = setTimeout(() => req.destroy(new FileFetchTimeoutError()), timeoutMs);
    }
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function byteCap(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveTimeout(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function advertisedContentLengthExceeds(
  headers: Record<string, string | string[] | undefined>,
  maxBytes: number,
): boolean {
  const raw = headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return false;
  const length = Number(value);
  return Number.isSafeInteger(length) && length > maxBytes;
}

async function resolveAndAssertSafeHttpUrlWithAddresses(
  rawUrl: string,
  lookup: HostLookup,
): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
  const url = assertSafeHttpUrl(rawUrl);
  const addresses = await lookup(stripIpv6Brackets(url.hostname));
  if (addresses.length === 0) throw new FileUrlBlockedError();
  for (const { address } of addresses) assertSafeHost(address);
  return { url, addresses };
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FileUrlBlockedError();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FileUrlBlockedError();
  return url;
}

async function defaultLookup(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const result = await dnsLookup(hostname, { all: true, verbatim: true });
  return result.map(({ address, family }) => ({ address, family }));
}

function assertSafeHost(rawHost: string): void {
  const host = stripIpv6Brackets(rawHost.toLowerCase());
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isBlockedIpv4(host) ||
    isBlockedIpv6(host)
  ) {
    throw new FileUrlBlockedError();
  }
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function normalizeAddressFamily(address: { address: string; family: number }): 4 | 6 {
  if (address.family === 4 || address.family === 6) return address.family;
  const parsedFamily = isIP(address.address);
  if (parsedFamily === 4 || parsedFamily === 6) return parsedFamily;
  throw new FileUrlBlockedError();
}

function isBlockedIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number(part));
  if (nums.some((num, index) => !Number.isInteger(num) || num < 0 || num > 255 || String(num) !== parts[index])) {
    return false;
  }
  const [a, b, c] = nums;
  return (
    a === 10 ||
    // RFC 6598 shared address space includes the Alibaba metadata address
    // 100.100.100.200; it is not public internet even though it is not RFC1918.
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    // IANA special-use / documentation / benchmarking ranges. Treat a URL
    // fetch as safe only when it is globally routable, not merely non-RFC1918.
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 31 && c === 196) ||
    (a === 192 && b === 52 && c === 193) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 175 && c === 48) ||
    (a === 169 && b === 254) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a === 0 ||
    a >= 224
  );
}

function isBlockedIpv6(host: string): boolean {
  if (isIP(host) !== 6) return false;
  const normalized = host.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  // Link-local is the whole fe80::/10 range: first byte 0xfe, top two bits of the
  // second byte = 10, i.e. fe80:..febf:. The four exact prefixes missed fe81:,
  // fe8a:, feb5:, … (RSH-60). Test the leading hextet numerically instead.
  const hextets = expandIpv6(normalized);
  // URL/IP parsing already accepted this as IPv6, but fail closed if this
  // local normalizer cannot prove its prefix shape.
  if (!hextets) return true;
  const firstHextet = hextets[0];
  if ((firstHextet & 0xffc0) === 0xfe80) return true;
  // Deprecated site-local addresses can still route to intranet services on
  // legacy deployments; they are no safer than link-local for SSRF purposes.
  if ((firstHextet & 0xffc0) === 0xfec0) return true;
  if ((firstHextet & 0xfe00) === 0xfc00) return true;
  if ((firstHextet & 0xff00) === 0xff00) return true;
  // RFC 6666 discard-only prefix and RFC 8215's local-use NAT64 prefix are
  // non-global. The latter deliberately maps to deployment-local IPv4 space.
  if (isIpv6DiscardOnly(hextets) || isLocalUseNat64(hextets)) return true;
  const embeddedIpv4 = embeddedIpv4Address(hextets);
  if (embeddedIpv4 && isBlockedIpv4(embeddedIpv4)) return true;
  const wellKnownNat64Ipv4 = wellKnownNat64Ipv4Address(hextets);
  if (wellKnownNat64Ipv4 && isBlockedIpv4(wellKnownNat64Ipv4)) return true;
  return false;
}

/**
 * Return the IPv4 address carried by an IPv4-compatible (`::/96`) or
 * IPv4-mapped (`::ffff:0:0/96`) IPv6 literal. Node normalizes dotted forms
 * such as `::127.0.0.1` to hexadecimal in URL hostnames, so prefix matching
 * `::ffff:` alone leaves private addresses such as `::7f00:1` reachable.
 */
function embeddedIpv4Address(hextets: number[]): string | null {
  const compatible = hextets.slice(0, 6).every((part) => part === 0);
  const mapped = hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
  // RFC 2765's IPv4-translatable form (`::ffff:0:0/96`) can reach the same
  // IPv4 destination through a translator, so it needs the exact same private
  // range policy as compatible and mapped forms.
  const translatable = hextets.slice(0, 4).every((part) => part === 0)
    && hextets[4] === 0xffff
    && hextets[5] === 0;
  if (!compatible && !mapped && !translatable) return null;
  const high = hextets[6];
  const low = hextets[7];
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function wellKnownNat64Ipv4Address(hextets: number[]): string | null {
  // RFC 6052 well-known prefix: 64:ff9b::/96. Decode its IPv4 tail so a
  // link-local/metadata target cannot be smuggled through a translator.
  if (
    hextets[0] !== 0x64
    || hextets[1] !== 0xff9b
    || !hextets.slice(2, 6).every((part) => part === 0)
  ) return null;
  const high = hextets[6];
  const low = hextets[7];
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function isLocalUseNat64(hextets: number[]): boolean {
  return hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets[2] === 1;
}

function isIpv6DiscardOnly(hextets: number[]): boolean {
  return hextets[0] === 0x100 && hextets.slice(1, 4).every((part) => part === 0);
}

function expandIpv6(host: string): number[] | null {
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = parseIpv6Side(halves[0]);
  const right = halves.length === 2 ? parseIpv6Side(halves[1]) : [];
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  return missing >= 1 ? [...left, ...Array<number>(missing).fill(0), ...right] : null;
}

function parseIpv6Side(side: string): number[] | null {
  if (!side) return [];
  const parts = side.split(':');
  const out: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.includes('.')) {
      if (index !== parts.length - 1) return null;
      const octets = part.split('.').map((value) => Number(value));
      if (octets.length !== 4 || octets.some((value, octet) => (
        !Number.isInteger(value) || value < 0 || value > 255 || String(value) !== part.split('.')[octet]
      ))) return null;
      out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    out.push(Number.parseInt(part, 16));
  }
  return out;
}
