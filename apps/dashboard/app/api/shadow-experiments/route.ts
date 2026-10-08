import { NextResponse } from 'next/server';
import { PROXY_URL, adminHeaders, assertAdminSecret } from '@/lib/proxy';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';

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

// The create fields the dashboard forwards (the editor's CreateExperimentBody:
// 18 required + optional window + funding_mode). `created_by` and `team_id`
// are NOT client-controlled: the proxy accepts `created_by` from the body, so
// forwarding the client's value would let any admin forge audit attribution.
const POST_CREATE_FIELDS = new Set<string>([
  'name',
  'source_provider',
  'source_model',
  'candidate_provider',
  'candidate_model',
  'sample_rate_ppm',
  'sampling_version',
  'shadow_sampling_key_version',
  'verifier_version',
  'gate_fingerprint',
  'max_samples',
  'deadline_ms',
  'max_concurrency',
  'max_queue_count',
  'max_queue_bytes',
  'max_payload_bytes',
  'per_run_cap_microcents',
  'aggregate_cap_microcents',
  'starts_at',
  'ends_at',
  'funding_mode',
]);

// Recognized keys that are ALWAYS set server-side; a client-supplied value is
// dropped (not rejected) and overwritten, so forged `created_by`/`team_id`
// cannot reach the proxy.
const POST_SERVER_SET_FIELDS = new Set<string>(['created_by', 'team_id']);

/**
 * Build the forwarded create body from the allowlist, setting `team_id` and
 * `created_by` authoritatively server-side (any client-supplied values for
 * those are dropped). Unknown fields are rejected with the proxy's diagnostic
 * shape rather than forwarded.
 */
function buildCreateBody(
  parsed: Record<string, unknown>,
  teamId: string,
  userId: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse } {
  const unknown = Object.keys(parsed).filter(
    (key) => !POST_CREATE_FIELDS.has(key) && !POST_SERVER_SET_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      response: jsonResponse(
        { error: { message: `Unknown create fields: ${unknown.join(', ')}`, code: 'invalid_field' } },
        400,
      ),
    };
  }
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(parsed)) {
    if (POST_CREATE_FIELDS.has(key)) body[key] = parsed[key];
  }
  body.team_id = teamId;
  body.created_by = userId;
  return { ok: true, body };
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

export async function GET() {
  // Pre-fetch phase: auth/demo/team resolution. A failure here is an internal
  // error, never "proxy unavailable".
  let teamId: string;
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return jsonResponse({ error: { message: 'Unauthorized', code: 'unauthorized' } }, 401);
    }
    try {
      assertAdminSecret();
    } catch {
      return adminSecretMissing();
    }
    // Demo mode swaps READ data to the seeded demo team; writes are guarded
    // separately and always stay scoped to the caller's real team. Fail closed
    // if the effective team cannot be resolved.
    const resolved = await getEffectiveTeamId(member.teamId);
    if (typeof resolved !== 'string' || resolved.trim() === '') {
      return jsonResponse({ error: { message: 'Team resolution failed', code: 'team_unresolved' } }, 500);
    }
    teamId = resolved;
  } catch (err) {
    console.error('shadow-experiments GET pre-fetch failed:', err);
    return internalError();
  }

  // Fetch-and-forward phase: only a genuine proxy failure lands on 502.
  try {
    const res = await fetch(
      `${PROXY_URL}/admin/shadow-experiments?team_id=${encodeURIComponent(teamId)}`,
      { headers: adminHeaders(), cache: 'no-store', signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS) },
    );
    return await passThroughProxyResponse(res);
  } catch (err) {
    console.error('Failed to fetch shadow experiments from proxy:', err);
    return proxyUnavailable();
  }
}

export async function POST(request: Request) {
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
    // Writes always target the caller's real team; demo writes are rejected
    // above before any team resolution.
    teamId = user.teamId;
    const parsed = await readJsonBody(request);
    if (!parsed) {
      return invalidBody();
    }
    const built = buildCreateBody(parsed, teamId, user.userId);
    if (!built.ok) {
      return built.response;
    }
    body = built.body;
  } catch (err) {
    console.error('shadow-experiments POST pre-fetch failed:', err);
    return internalError();
  }

  try {
    const res = await fetch(
      `${PROXY_URL}/admin/shadow-experiments?team_id=${encodeURIComponent(teamId)}`,
      {
        method: 'POST',
        headers: adminHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
      },
    );
    return await passThroughProxyResponse(res);
  } catch (err) {
    console.error('Failed to create shadow experiment via proxy:', err);
    return proxyUnavailable();
  }
}
