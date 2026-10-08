import { NextResponse } from 'next/server';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';

// CSP violation report sink for the RSH-53 report-only rollout. The strict
// Content-Security-Policy-Report-Only header (set in middleware) points its
// report-uri here so we can see what a strict, nonce-based policy WOULD block
// before we enforce it.
//
// Unauthenticated by design: browsers POST violation reports without
// credentials. Must never throw or 500 on a malformed body — a report endpoint
// that errors is worse than useless.

// Cap per array request so one POST can't emit unbounded log lines.
const MAX_REPORTS_PER_REQUEST = 10;

interface NormalizedReport {
  directive?: unknown;
  blocked?: unknown;
  doc?: unknown;
}

/** Strip the query/fragment and cap length: a document-uri for an authenticated
 * page can carry tokens/PII in the query string, and the field is otherwise
 * attacker-controlled. */
function safeUri(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.split(/[?#]/)[0]!.slice(0, 256);
}

function safeStr(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, max);
}

// Accept both the legacy report-uri shape ({ "csp-report": {...} }) and the
// modern Reporting API shape (an array of { type, body: {...} }).
function normalize(body: unknown): NormalizedReport[] {
  if (Array.isArray(body)) {
    return body
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => {
        const b = ((r as { body?: unknown }).body ?? {}) as Record<string, unknown>;
        return {
          directive: b['effectiveDirective'] ?? b['violated-directive'] ?? b['effective-directive'],
          blocked: b['blockedURL'] ?? b['blocked-uri'],
          doc: b['documentURL'] ?? b['document-uri'],
        };
      });
  }
  if (body && typeof body === 'object') {
    const inner = (
      'csp-report' in body
        ? (body as { 'csp-report'?: unknown })['csp-report']
        : body
    ) as Record<string, unknown> | undefined;
    if (inner && typeof inner === 'object') {
      return [
        {
          directive: inner['violated-directive'] ?? inner['effective-directive'],
          blocked: inner['blocked-uri'],
          doc: inner['document-uri'],
        },
      ];
    }
  }
  return [];
}

export async function POST(request: Request): Promise<NextResponse> {
  // Unauthenticated + public: throttle per client so it can't be used to flood
  // logs / drive up ingestion cost. Return 204 even when throttled so browsers
  // never treat the report sink as failing. (The sibling public endpoints added
  // in RSH-52 are all rate-limited; this one was missed.)
  const rl = checkRateLimit(`csp-report:${getClientIp(request)}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return new NextResponse(null, { status: 204 });

  try {
    const body = (await request.json().catch(() => null)) as unknown;
    for (const report of normalize(body).slice(0, MAX_REPORTS_PER_REQUEST)) {
      const directive = safeStr(report.directive, 120);
      const blocked = safeUri(report.blocked);
      const doc = safeUri(report.doc);
      if (!directive && !blocked && !doc) continue;
      // CSP reports are expected report-only telemetry. Keep them in Railway stdout
      // without turning each browser report into a Sentry warning via captureConsoleIntegration.
      console.info('[csp-report]', JSON.stringify({ directive, blocked, doc }));
    }
  } catch {
    // Never surface an error to the reporting browser.
  }
  return new NextResponse(null, { status: 204 });
}
