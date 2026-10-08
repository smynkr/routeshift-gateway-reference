import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import middleware, { config } from '../middleware';

const AUTH_COOKIE = 'authjs.session-token=test-session';

function request(path: string, authenticated = false, headers: HeadersInit = {}): NextRequest {
  const requestHeaders = new Headers(headers);
  if (authenticated) requestHeaders.set('cookie', AUTH_COOKIE);
  return new NextRequest(`https://app.routeshift.io${path}`, { headers: requestHeaders });
}

function reportOnlyPolicy(response: ReturnType<typeof middleware>): string {
  const policy = response.headers.get('content-security-policy-report-only');
  expect(policy).toBeTruthy();
  return policy!;
}

function nonceFrom(policy: string): string {
  const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
  expect(nonce).toMatch(/^[A-Za-z0-9+/]+$/);
  expect(nonce!.length).toBeGreaterThanOrEqual(64);
  return nonce!;
}

describe('authenticated route CSP nonce', () => {
  it('generates a fresh cryptographic nonce for every request', () => {
    const first = nonceFrom(reportOnlyPolicy(middleware(request('/overview', true))));
    const second = nonceFrom(reportOnlyPolicy(middleware(request('/overview', true))));

    expect(first).not.toBe(second);
  });

  it('propagates the same nonce through Next.js request headers and the report-only response', () => {
    const response = middleware(request('/settings?tab=security', true, {
      'content-security-policy': "script-src 'unsafe-inline'",
      'x-nonce': 'attacker-controlled',
    }));
    const policy = reportOnlyPolicy(response);
    const nonce = nonceFrom(policy);

    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(response.headers.get('x-middleware-request-x-routeshift-callback-url'))
      .toBe('/settings?tab=security');
    expect(response.headers.get('x-middleware-override-headers')).toContain('x-nonce');
  });

  it('keeps scripts strict while limiting the remaining inline exception to style attributes', () => {
    const policy = reportOnlyPolicy(middleware(request('/overview', true)));
    const scriptDirective = policy.split('; ').find((directive) => directive.startsWith('script-src '));

    expect(scriptDirective).toContain("'strict-dynamic'");
    expect(scriptDirective).toContain("'nonce-");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(policy).toContain("style-src 'self' 'nonce-");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).toContain('report-uri /api/csp-report');
  });

  it.each([
    '/',
    '/login',
    '/models/gpt-5',
    '/api/csp-report',
    '/_next/static/chunks/app.js',
    '/sitemap.xml',
    '/robots.txt',
  ])('does not opt public or static route %s into nonce rendering', (path) => {
    const response = middleware(request(path, true));

    expect(response.headers.get('content-security-policy-report-only')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-nonce')).toBeNull();
  });

  it('redirects unauthenticated protected routes without attaching a nonce', () => {
    const response = middleware(request('/settings?tab=security'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://app.routeshift.io/login?callbackUrl=%2Fsettings%3Ftab%3Dsecurity',
    );
    expect(response.headers.get('content-security-policy-report-only')).toBeNull();
    expect(response.headers.get('x-middleware-request-x-nonce')).toBeNull();
  });

  it('keeps the matcher scoped away from public and static routes', () => {
    expect(config.matcher).toHaveLength(1);
    expect(config.matcher[0]).toContain('api/');
    expect(config.matcher[0]).toContain('_next/static');
    expect(config.matcher[0]).toContain('sitemap.xml');
    expect(config.matcher[0]).toContain('robots.txt');
  });
});
