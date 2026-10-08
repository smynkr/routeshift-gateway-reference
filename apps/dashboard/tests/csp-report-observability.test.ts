import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getClientIp: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: h.checkRateLimit,
  getClientIp: h.getClientIp,
}));

import { POST } from '@/app/api/csp-report/route';

describe('CSP report observability contract', () => {
  beforeEach(() => {
    h.checkRateLimit.mockReturnValue({ allowed: true });
    h.getClientIp.mockReturnValue('203.0.113.9');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records an accepted browser report without emitting a Sentry-captured warning', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = await POST(
      new Request('https://app.routeshift.io/api/csp-report', {
        method: 'POST',
        headers: { 'content-type': 'application/csp-report' },
        body: JSON.stringify({
          'csp-report': {
            'violated-directive': 'script-src-elem',
            'blocked-uri': 'https://app.routeshift.io/cdn-cgi/challenge-platform/scripts/jsd/main.js',
            'document-uri': 'https://app.routeshift.io/keys?access_token=should-not-log',
          },
        }),
      }),
    );

    expect(response.status).toBe(204);
    expect(info).toHaveBeenCalledWith(
      '[csp-report]',
      expect.stringContaining('"directive":"script-src-elem"'),
    );
    expect(info).toHaveBeenCalledWith(
      '[csp-report]',
      expect.not.stringContaining('access_token'),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
