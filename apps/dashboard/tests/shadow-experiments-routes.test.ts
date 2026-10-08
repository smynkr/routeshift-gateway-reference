import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' } as {
    userId: string;
    teamId: string;
    role: string;
  } | null,
  fetch: vi.fn(),
  demoActive: false,
  adminSecretThrows: false,
  getEffectiveTeamId: vi.fn(),
  requireTeamMembership: vi.fn(),
  requireRole: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: () => h.requireTeamMembership(),
  requireRole: (role: string) => h.requireRole(role),
}));
vi.mock('@/lib/demo', () => ({
  isDemoActive: async () => h.demoActive,
  getEffectiveTeamId: (teamId: string | null | undefined) => h.getEffectiveTeamId(teamId),
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only.',
}));
vi.mock('@/lib/proxy', () => ({
  PROXY_URL: 'https://proxy.test',
  adminHeaders: (extra: Record<string, string> = {}) => ({ ...extra, Authorization: 'Bearer admin' }),
  assertAdminSecret: () => {
    if (h.adminSecretThrows) throw new Error('Proxy admin secret not configured');
  },
}));

import { GET as listGET, POST as createPOST } from '@/app/api/shadow-experiments/route';
import { PATCH as updatePATCH, DELETE as deleteExperiment } from '@/app/api/shadow-experiments/[id]/route';

const VALID_CREATE_BODY = {
  name: 'Candidate eval',
  source_provider: 'openai',
  source_model: 'gpt-5',
  candidate_provider: 'anthropic',
  candidate_model: 'claude-sonnet-4-6',
  sample_rate_ppm: 50_000,
  sampling_version: 'v1',
  shadow_sampling_key_version: 'key-v1',
  verifier_version: 'rsh72-v1',
  gate_fingerprint: 'sha256:ab12',
  max_samples: 1_000,
  deadline_ms: 30_000,
  max_concurrency: 2,
  max_queue_count: 100,
  max_queue_bytes: 10_485_760,
  max_payload_bytes: 1_048_576,
  per_run_cap_microcents: 50_000_000,
  aggregate_cap_microcents: 5_000_000_000,
};

function jsonRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function rawBodyRequest(method: string, path: string, body: string): Request {
  return new Request(`https://app.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

function proxyResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function rawProxyResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

beforeEach(() => {
  h.member = { userId: 'user_1', teamId: 'team_1', role: 'admin' };
  h.demoActive = false;
  h.adminSecretThrows = false;
  h.fetch.mockReset();
  h.getEffectiveTeamId.mockReset();
  h.getEffectiveTeamId.mockImplementation(async (teamId: string | null | undefined) =>
    h.demoActive ? 'team_demo' : teamId ?? null,
  );
  h.requireTeamMembership.mockReset();
  h.requireTeamMembership.mockImplementation(async () => h.member);
  h.requireRole.mockReset();
  h.requireRole.mockImplementation(async () =>
    h.member && (h.member.role === 'admin' || h.member.role === 'owner') ? h.member : null,
  );
  vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
});

describe('GET /api/shadow-experiments', () => {
  it('returns 401 with the unauthorized envelope without a team member, never calling the proxy', async () => {
    h.member = null;
    const response = await listGET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: 'Unauthorized', code: 'unauthorized' } });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('forwards the real team id to the proxy and passes the response through', async () => {
    const rows = [{ id: 'exp_1', name: 'Candidate eval' }];
    h.fetch.mockResolvedValueOnce(proxyResponse(200, { experiments: rows }));

    const response = await listGET();

    expect(h.getEffectiveTeamId).toHaveBeenCalledWith('team_1');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://proxy.test/admin/shadow-experiments?team_id=team_1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ experiments: rows });
  });

  it('marks every response no-store so team-scoped data is never cached', async () => {
    // FRESH response per call: reusing one Response object consumes its body
    // on the first read and the later routes' reads throw
    // 'Body is unusable: Body has already been read' (masked 502s).
    h.fetch
      .mockResolvedValueOnce(proxyResponse(200, { experiments: [] }))
      .mockResolvedValueOnce(proxyResponse(200, { ok: true }))
      .mockResolvedValueOnce(proxyResponse(200, { deleted: true }));
    const getResponse = await listGET();
    expect(getResponse.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
    expect(getResponse.status).toBe(200);

    const ctx = { params: Promise.resolve({ id: 'exp_1' }) };
    const patchResponse = await updatePATCH(
      jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { name: 'x' }),
      ctx,
    );
    expect(patchResponse.status).toBe(200); // NOT a masked 502
    expect(patchResponse.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');

    const deleteResponse = await deleteExperiment(
      new Request('https://app.test/api/shadow-experiments/exp_1', { method: 'DELETE' }),
      ctx,
    );
    expect(deleteResponse.status).toBe(200); // NOT a masked 502
    expect(deleteResponse.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
  });

  it('swaps reads to the seeded demo team when demo mode is active', async () => {
    h.demoActive = true;
    h.fetch.mockResolvedValueOnce(proxyResponse(200, { experiments: [] }));

    const response = await listGET();

    expect(h.getEffectiveTeamId).toHaveBeenCalledWith('team_1');
    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://proxy.test/admin/shadow-experiments?team_id=team_demo');
    expect(response.status).toBe(200);
  });

  it('passes the proxy 404 shadow_routing_disabled envelope through verbatim', async () => {
    h.fetch.mockResolvedValueOnce(
      proxyResponse(404, { error: { message: 'Shadow routing is not enabled', code: 'shadow_routing_disabled' } }),
    );

    const response = await listGET();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: 'Shadow routing is not enabled', code: 'shadow_routing_disabled' },
    });
  });

  it('surfaces a 2xx non-JSON proxy body as 502 (never a success status with an error envelope)', async () => {
    h.fetch.mockResolvedValueOnce(rawProxyResponse(200, '<html>upstream ok</html>'));

    const response = await listGET();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: 'Proxy returned a non-JSON response', code: 'proxy_non_json_response' },
    });
  });

  it('preserves a 502 from the proxy as 502 proxy_non_json_response when the body is not JSON', async () => {
    h.fetch.mockResolvedValueOnce(rawProxyResponse(502, '<html>bad gateway</html>'));

    const response = await listGET();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: 'Proxy returned a non-JSON response', code: 'proxy_non_json_response' },
    });
  });

  it('fails closed with 502 proxy_unavailable only when the fetch itself throws', async () => {
    h.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const response = await listGET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: 'Proxy unavailable', code: 'proxy_unavailable' },
    });
  });

  it('fails closed with 502 proxy_unavailable when the proxy fetch times out (AbortError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    h.fetch.mockRejectedValueOnce(abortError);
    const response = await listGET();
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('proxy_unavailable');
  });

  it('returns 500 team_unresolved and never calls the proxy when getEffectiveTeamId yields null', async () => {
    h.getEffectiveTeamId.mockResolvedValue(null);
    const response = await listGET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { message: 'Team resolution failed', code: 'team_unresolved' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('returns 500 internal_error (not 502) when an early-branch dependency throws', async () => {
    h.requireTeamMembership.mockRejectedValueOnce(new Error('session store blew up'));
    const response = await listGET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { message: 'Internal error', code: 'internal_error' } });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('fails closed with 500 admin_secret_missing when the admin secret is not configured', async () => {
    h.adminSecretThrows = true;
    const response = await listGET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { message: 'ADMIN_SECRET is not configured', code: 'admin_secret_missing' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe('POST /api/shadow-experiments', () => {
  it('blocks demo writes with 403 demo_write_blocked before any proxy call', async () => {
    h.demoActive = true;
    const response = await createPOST(jsonRequest('POST', '/api/shadow-experiments', VALID_CREATE_BODY));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { message: 'Demo mode is read-only.', code: 'demo_write_blocked' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('blocks non-admin writes with the forbidden envelope before any proxy call', async () => {
    h.member = { userId: 'user_2', teamId: 'team_1', role: 'member' };
    const response = await createPOST(jsonRequest('POST', '/api/shadow-experiments', VALID_CREATE_BODY));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: 'Forbidden', code: 'forbidden' } });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('returns demo_write_blocked (not forbidden) when demo is active even for a non-admin', async () => {
    h.demoActive = true;
    h.member = { userId: 'user_2', teamId: 'team_1', role: 'member' };
    const response = await createPOST(jsonRequest('POST', '/api/shadow-experiments', VALID_CREATE_BODY));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('demo_write_blocked');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('forwards the create body with the session team_id + created_by and passes 201 through', async () => {
    const created = { id: 'exp_1', ...VALID_CREATE_BODY, enabled: false };
    h.fetch.mockResolvedValueOnce(proxyResponse(201, { experiment: created }));

    const response = await createPOST(jsonRequest('POST', '/api/shadow-experiments', VALID_CREATE_BODY));

    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://proxy.test/admin/shadow-experiments?team_id=team_1');
    const init = h.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      ...VALID_CREATE_BODY,
      team_id: 'team_1',
      created_by: 'user_1',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ experiment: created });
  });

  it('overrides a client-forged created_by with the session user id', async () => {
    h.fetch.mockResolvedValueOnce(proxyResponse(201, { experiment: { id: 'exp_1' } }));

    await createPOST(
      jsonRequest('POST', '/api/shadow-experiments', { ...VALID_CREATE_BODY, created_by: 'ceo@forged.example' }),
    );

    const init = h.fetch.mock.calls[0]?.[1] as RequestInit;
    const forwarded = JSON.parse(String(init.body));
    expect(forwarded.created_by).toBe('user_1');
    expect(forwarded.created_by).not.toBe('ceo@forged.example');
  });

  it('rejects a create body with an unknown field with 400 invalid_field', async () => {
    const response = await createPOST(
      jsonRequest('POST', '/api/shadow-experiments', { ...VALID_CREATE_BODY, random_field: 'junk' }),
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe('invalid_field');
    expect(payload.error.message).toContain('random_field');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400 invalid_body before any proxy call', async () => {
    const response = await createPOST(rawBodyRequest('POST', '/api/shadow-experiments', '{not-valid-json'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'Invalid JSON in request body', code: 'invalid_body' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects a JSON null body with 400 invalid_body', async () => {
    const response = await createPOST(rawBodyRequest('POST', '/api/shadow-experiments', 'null'));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_body');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects a JSON array body with 400 invalid_body', async () => {
    const response = await createPOST(rawBodyRequest('POST', '/api/shadow-experiments', '[1,2,3]'));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_body');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('passes proxy validation errors through verbatim', async () => {
    h.fetch.mockResolvedValueOnce(
      proxyResponse(400, { error: { message: 'Missing required fields: name', code: 'missing_fields' } }),
    );

    const response = await createPOST(jsonRequest('POST', '/api/shadow-experiments', { name: 'Incomplete' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'Missing required fields: name', code: 'missing_fields' },
    });
  });
});

describe('PATCH /api/shadow-experiments/[id]', () => {
  const ctx = { params: Promise.resolve({ id: 'exp_1' }) };

  it('blocks demo writes with 403 demo_write_blocked before any proxy call', async () => {
    h.demoActive = true;
    const response = await updatePATCH(jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { name: 'New' }), ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { message: 'Demo mode is read-only.', code: 'demo_write_blocked' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('blocks non-admin writes with the forbidden envelope before any proxy call', async () => {
    h.member = { userId: 'user_2', teamId: 'team_1', role: 'member' };
    const response = await updatePATCH(jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { name: 'New' }), ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: 'Forbidden', code: 'forbidden' } });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('forwards the patch to the scoped proxy URL and passes 200 through', async () => {
    const updated = { id: 'exp_1', name: 'Renamed' };
    h.fetch.mockResolvedValueOnce(proxyResponse(200, { experiment: updated }));

    const response = await updatePATCH(
      jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { name: 'Renamed' }),
      ctx,
    );

    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://proxy.test/admin/shadow-experiments/exp_1?team_id=team_1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ experiment: updated });
  });

  it('targets the REAL session team even if the demo read swap would resolve another team', async () => {
    // Simulate the race the fix removes: even if getEffectiveTeamId would hand
    // back the demo team, the write path must never consult it.
    h.getEffectiveTeamId.mockImplementation(async () => 'team_demo');
    h.fetch.mockResolvedValueOnce(proxyResponse(200, { experiment: { id: 'exp_1' } }));

    await updatePATCH(jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { name: 'Renamed' }), ctx);

    expect(h.getEffectiveTeamId).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://proxy.test/admin/shadow-experiments/exp_1?team_id=team_1');
  });

  it('rejects malformed JSON with 400 invalid_body before any proxy call', async () => {
    const response = await updatePATCH(rawBodyRequest('PATCH', '/api/shadow-experiments/exp_1', '{oops'), ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { message: 'Invalid JSON in request body', code: 'invalid_body' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects a JSON array body with 400 invalid_body', async () => {
    const response = await updatePATCH(rawBodyRequest('PATCH', '/api/shadow-experiments/exp_1', '[]'), ctx);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_body');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects a PATCH body with immutable/unknown keys via 400 invalid_field (no silent strip)', async () => {
    const response = await updatePATCH(
      jsonRequest('PATCH', '/api/shadow-experiments/exp_1', {
        name: 'Hygienic',
        team_id: 'other_team',
        sampling_version: 'v9',
        random_field: 'junk',
      }),
      ctx,
    );
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe('invalid_field');
    expect(payload.error.message).toContain('team_id');
    expect(payload.error.message).toContain('sampling_version');
    expect(payload.error.message).toContain('random_field');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty PATCH body with 400 no_fields', async () => {
    const response = await updatePATCH(jsonRequest('PATCH', '/api/shadow-experiments/exp_1', {}), ctx);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: 'No mutable fields provided', code: 'no_fields' } });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('forwards a clean mutable-only PATCH body unchanged', async () => {
    h.fetch.mockResolvedValueOnce(proxyResponse(200, { experiment: { id: 'exp_1', name: 'Hygienic' } }));
    const response = await updatePATCH(
      jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { name: 'Hygienic', max_samples: 5 }),
      ctx,
    );
    expect(response.status).toBe(200);
    const init = h.fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Hygienic', max_samples: 5 });
  });

  it('fails closed with 500 admin_secret_missing when the admin secret is not configured', async () => {
    h.adminSecretThrows = true;
    const response = await updatePATCH(jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { name: 'x' }), ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { message: 'ADMIN_SECRET is not configured', code: 'admin_secret_missing' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('returns demo_write_blocked (not forbidden) when demo is active even for a non-admin', async () => {
    h.demoActive = true;
    h.member = { userId: 'user_2', teamId: 'team_1', role: 'member' };
    const response = await updatePATCH(jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { name: 'x' }), ctx);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('demo_write_blocked');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('passes the 409 shadow_enablement_unavailable refusal through verbatim', async () => {
    h.fetch.mockResolvedValueOnce(
      proxyResponse(409, {
        error: {
          message: 'Shadow experiment enablement is unavailable until the approved consent workflow is implemented',
          code: 'shadow_enablement_unavailable',
        },
      }),
    );

    const response = await updatePATCH(
      jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { enabled: true }),
      ctx,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        message: 'Shadow experiment enablement is unavailable until the approved consent workflow is implemented',
        code: 'shadow_enablement_unavailable',
      },
    });
  });

  it('passes bound-contract violations with their diagnostic suffix through verbatim', async () => {
    h.fetch.mockResolvedValueOnce(
      proxyResponse(400, {
        error: {
          message: 'Execution-bound contract would be invalid: aggregate_cap_microcents; repair all invalid bounds atomically before annotations',
          code: 'invalid_execution_bound',
        },
      }),
    );

    const response = await updatePATCH(
      jsonRequest('PATCH', '/api/shadow-experiments/exp_1', { aggregate_cap_microcents: 1 }),
      ctx,
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe('invalid_execution_bound');
    expect(payload.error.message).toContain(': aggregate_cap_microcents');
  });

  it('passes the 404 not_found envelope through verbatim', async () => {
    h.fetch.mockResolvedValueOnce(proxyResponse(404, { error: { message: 'Experiment not found', code: 'not_found' } }));
    const response = await updatePATCH(jsonRequest('PATCH', '/api/shadow-experiments/missing', { name: 'x' }), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: 'Experiment not found', code: 'not_found' } });
  });
});

describe('DELETE /api/shadow-experiments/[id]', () => {
  const ctx = { params: Promise.resolve({ id: 'exp_1' }) };

  it('blocks demo deletes with 403 demo_write_blocked before any proxy call', async () => {
    h.demoActive = true;
    const response = await deleteExperiment(new Request('https://app.test/api/shadow-experiments/exp_1', { method: 'DELETE' }), ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { message: 'Demo mode is read-only.', code: 'demo_write_blocked' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('blocks non-admin deletes with the forbidden envelope before any proxy call', async () => {
    h.member = { userId: 'user_2', teamId: 'team_1', role: 'member' };
    const response = await deleteExperiment(new Request('https://app.test/api/shadow-experiments/exp_1', { method: 'DELETE' }), ctx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { message: 'Forbidden', code: 'forbidden' } });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('fails closed with 500 admin_secret_missing when the admin secret is not configured', async () => {
    h.adminSecretThrows = true;
    const response = await deleteExperiment(new Request('https://app.test/api/shadow-experiments/exp_1', { method: 'DELETE' }), ctx);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { message: 'ADMIN_SECRET is not configured', code: 'admin_secret_missing' },
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('forwards the delete and passes the 200 confirmation through', async () => {
    h.fetch.mockResolvedValueOnce(proxyResponse(200, { deleted: true }));
    const response = await deleteExperiment(new Request('https://app.test/api/shadow-experiments/exp_1', { method: 'DELETE' }), ctx);
    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://proxy.test/admin/shadow-experiments/exp_1?team_id=team_1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
  });

  it('targets the REAL session team even if the demo read swap would resolve another team', async () => {
    h.getEffectiveTeamId.mockImplementation(async () => 'team_demo');
    h.fetch.mockResolvedValueOnce(proxyResponse(200, { deleted: true }));

    await deleteExperiment(new Request('https://app.test/api/shadow-experiments/exp_1', { method: 'DELETE' }), ctx);

    expect(h.getEffectiveTeamId).not.toHaveBeenCalled();
    expect(h.fetch.mock.calls[0]?.[0]).toBe('https://proxy.test/admin/shadow-experiments/exp_1?team_id=team_1');
  });

  it('passes the 404 not_found envelope through verbatim', async () => {
    h.fetch.mockResolvedValueOnce(proxyResponse(404, { error: { message: 'Experiment not found', code: 'not_found' } }));
    const response = await deleteExperiment(new Request('https://app.test/api/shadow-experiments/missing', { method: 'DELETE' }), ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { message: 'Experiment not found', code: 'not_found' } });
  });
});
