import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireRole } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, isDemoActive } from '@/lib/demo';

// Team-scoped admin data must never be cached by the browser or an intermediary.
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

function jsonResponse(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function adminSecretMissing(): NextResponse {
  return jsonResponse(
    { error: { message: 'ADMIN_SECRET is not configured', code: 'admin_secret_missing' } },
    500,
  );
}

function invalidBody(): NextResponse {
  return jsonResponse(
    { error: { message: 'Invalid JSON in request body', code: 'invalid_body' } },
    400,
  );
}

function proxyNonJson(status: number): NextResponse {
  return jsonResponse(
    { error: { message: 'Proxy returned a non-JSON response', code: 'proxy_non_json_response' } },
    status,
  );
}

function internalError(): NextResponse {
  return jsonResponse({ error: { message: 'Internal error', code: 'internal_error' } }, 500);
}

function proxyUnavailable(): NextResponse {
  return jsonResponse({ error: { message: 'Proxy unavailable', code: 'proxy_unavailable' } }, 502);
}

// A hung proxy must not pin the route handler indefinitely.
const PROXY_FETCH_TIMEOUT_MS = 10_000;

// The proxy's PATCH mutable whitelist. Defense-in-depth under the proxy: the
// dashboard REJECTS unknown/immutable keys (team_id, sampling_version, …)
// rather than silently stripping them — a silent strip could filter a body to
// `{}`, the proxy would return 200-unchanged, and the caller would read
// "success" for a request that deserved 400. `enabled` is kept — the proxy
// itself rejects `enabled: true` with 409 shadow_enablement_unavailable, and
// that contract stays visible.
const PATCH_MUTABLE_FIELDS = new Set<string>([
  'name',
  'enabled',
  'sample_rate_ppm',
  'max_samples',
  'starts_at',
  'ends_at',
  'deadline_ms',
  'max_concurrency',
  'max_queue_count',
  'max_queue_bytes',
  'max_payload_bytes',
  'per_run_cap_microcents',
  'aggregate_cap_microcents',
  'disabled_reason',
  'kill_switch_at',
]);

function validatePatchBody(
  body: Record<string, unknown>,
): { ok: true; filtered: Record<string, unknown> } | { ok: false; response: NextResponse } {
  const unknown = Object.keys(body).filter((key) => !PATCH_MUTABLE_FIELDS.has(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      response: jsonResponse(
        { error: { message: `Unknown mutable fields: ${unknown.join(', ')}`, code: 'invalid_field' } },
        400,
      ),
    };
  }
  if (Object.keys(body).length === 0) {
    return {
      ok: false,
      response: jsonResponse(
        { error: { message: 'No mutable fields provided', code: 'no_fields' } },
        400,
      ),
    };
  }
  return { ok: true, filtered: body };
}

/** Parse the request body as a plain JSON object; null on any failure. */
async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Forward a proxy response preserving its status. A non-JSON body on a 2xx is
 * surfaced as 502 — the route must never hand a success status to an error
 * envelope (the caller branches on `response.ok` and would silently treat a
 * possibly-lost write as saved). Non-2xx statuses pass through verbatim.
 */
async function passThroughProxyResponse(res: Response): Promise<NextResponse> {
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return proxyNonJson(res.ok ? 502 : res.status);
  }
  return jsonResponse(data, res.status);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Pre-fetch phase: auth/demo/params/body. A failure here is an internal
  // error, never "proxy unavailable".
  let id: string;
  let teamId: string;
  let body: Record<string, unknown>;
  try {
    if (await isDemoActive()) {
      return jsonResponse(
        { error: { message: DEMO_WRITE_BLOCKED_MESSAGE, code: 'demo_write_blocked' } },
        403,
      );
    }
    const user = await requireRole('admin');
    if (!user) {
      return jsonResponse({ error: { message: 'Forbidden', code: 'forbidden' } }, 403);
    }
    try {
      assertAdminSecret();
    } catch {
      return adminSecretMissing();
    }
    ({ id } = await params);
    // Writes always target the caller's real team; demo writes are rejected
    // above before any team resolution, so no demo swap applies to mutations.
    teamId = user.teamId;
    const parsed = await readJsonBody(request);
    if (!parsed) {
      return invalidBody();
    }
    const validated = validatePatchBody(parsed);
    if (!validated.ok) {
      return validated.response;
    }
    body = validated.filtered;
  } catch (err) {
    console.error('shadow-experiments PATCH pre-fetch failed:', err);
    return internalError();
  }

  try {
    const res = await fetch(
      `${PROXY_URL}/admin/shadow-experiments/${encodeURIComponent(id)}?team_id=${encodeURIComponent(teamId)}`,
      {
        method: 'PATCH',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
      },
    );
    return await passThroughProxyResponse(res);
  } catch (err) {
    console.error('Failed to update shadow experiment via proxy:', err);
    return proxyUnavailable();
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let id: string;
  let teamId: string;
  try {
    if (await isDemoActive()) {
      return jsonResponse(
        { error: { message: DEMO_WRITE_BLOCKED_MESSAGE, code: 'demo_write_blocked' } },
        403,
      );
    }
    const user = await requireRole('admin');
    if (!user) {
      return jsonResponse({ error: { message: 'Forbidden', code: 'forbidden' } }, 403);
    }
    try {
      assertAdminSecret();
    } catch {
      return adminSecretMissing();
    }
    ({ id } = await params);
    // Writes always target the caller's real team; demo writes are rejected
    // above before any team resolution, so no demo swap applies to mutations.
    teamId = user.teamId;
  } catch (err) {
    console.error('shadow-experiments DELETE pre-fetch failed:', err);
    return internalError();
  }

  try {
    const res = await fetch(
      `${PROXY_URL}/admin/shadow-experiments/${encodeURIComponent(id)}?team_id=${encodeURIComponent(teamId)}`,
      {
        method: 'DELETE',
        headers: adminHeaders(),
        cache: 'no-store',
        signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
      },
    );
    return await passThroughProxyResponse(res);
  } catch (err) {
    console.error('Failed to delete shadow experiment via proxy:', err);
    return proxyUnavailable();
  }
}
