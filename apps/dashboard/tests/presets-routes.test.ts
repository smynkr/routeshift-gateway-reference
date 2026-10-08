import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EFFECTIVE_DISPATCHABLE_CHAT_MODELS, MODEL_REGISTRY } from '@routeshift/shared';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' } as {
    userId: string;
    teamId: string;
    role: string;
  } | null,
  query: vi.fn(),
  connect: vi.fn(),
  fetch: vi.fn(),
  randomUUID: vi.fn(() => '11111111-2222-4333-8444-555555555555'),
  demoActive: false,
}));

vi.mock('node:crypto', () => ({ randomUUID: h.randomUUID }));
vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: async () => h.member,
  requireRole: async () => h.member?.role === 'admin' ? h.member : null,
}));
vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: h.query, connect: h.connect }),
}));
vi.mock('@/lib/proxy', () => ({
  PROXY_URL: 'https://proxy.test',
  assertAdminSecret: () => {},
  adminHeaders: (extra: Record<string, string> = {}) => ({ ...extra, Authorization: 'Bearer admin' }),
}));
vi.mock('@/lib/demo', () => ({
  isDemoActive: async () => h.demoActive,
  getEffectiveTeamId: async (teamId: string | null | undefined) => (
    h.demoActive ? 'team_demo' : teamId ?? null
  ),
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only.',
}));

import { GET as listGET, POST as createPOST } from '@/app/api/presets/route';
import { GET as detailGET, PUT as updatePUT, DELETE as deletePreset } from '@/app/api/presets/[slug]/route';
import { GET as versionsGET } from '@/app/api/presets/[slug]/versions/route';
import { GET as versionGET } from '@/app/api/presets/[slug]/versions/[version]/route';

const GENERATED_CHAT_MODEL = EFFECTIVE_DISPATCHABLE_CHAT_MODELS.find((model) => (
  'source' in model
  && model.source === 'generated'
  && model.canonical_name.includes(':')
  && !MODEL_REGISTRY.some((entry) => entry.canonical_name === model.canonical_name)
));

function jsonReq(path: string, body: unknown): Request {
  return new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeClient() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('UPDATE presets') && sql.includes('RETURNING')) {
        return { rows: [{ id: 'preset_existing', version: 2 }] };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
    calls,
  };
  h.connect.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  h.member = { userId: 'user_1', teamId: 'team_1', role: 'admin' };
  h.demoActive = false;
  h.query.mockReset();
  h.connect.mockReset();
  h.fetch.mockReset();
  h.randomUUID.mockClear();
  vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
  h.fetch.mockResolvedValue(new Response(JSON.stringify({ invalidated: true }), { status: 200 }));
});

describe('presets API routes', () => {
  it('blocks every preset write in demo mode before database or proxy work', async () => {
    h.demoActive = true;
    const [create, update, remove] = await Promise.all([
      createPOST(jsonReq('/api/presets', {
        slug: 'support-bot', model: 'gpt-5.4', params: {}, system_prompt: 'help', provider_prefs: null,
      })),
      updatePUT(jsonReq('/api/presets/support-bot', {
        model: 'gpt-5.4', params: {}, system_prompt: 'help', provider_prefs: null,
      }), { params: Promise.resolve({ slug: 'support-bot' }) }),
      deletePreset(new Request('https://app.test/api/presets/support-bot?disable=true'), { params: Promise.resolve({ slug: 'support-bot' }) }),
    ]);

    expect([create.status, update.status, remove.status]).toEqual([403, 403, 403]);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('blocks non-admin preset writes before database or proxy work', async () => {
    h.member = { userId: 'user_2', teamId: 'team_1', role: 'member' };
    const [create, update, remove] = await Promise.all([
      createPOST(jsonReq('/api/presets', {
        slug: 'support-bot', model: 'gpt-5.4', params: {}, system_prompt: 'help', provider_prefs: null,
      })),
      updatePUT(jsonReq('/api/presets/support-bot', {
        model: 'gpt-5.4', params: {}, system_prompt: 'help', provider_prefs: null,
      }), { params: Promise.resolve({ slug: 'support-bot' }) }),
      deletePreset(new Request('https://app.test/api/presets/support-bot'), { params: Promise.resolve({ slug: 'support-bot' }) }),
    ]);

    expect([create.status, update.status, remove.status]).toEqual([403, 403, 403]);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('lists only the authenticated team presets', async () => {
    h.query.mockResolvedValueOnce({ rows: [{
      slug: 'support-bot', version: 1, model: 'gpt-5.4', params: { temperature: 0.2 },
      system_prompt: 'help', provider_prefs: { data_collection: 'deny' }, enabled: true,
      updated_at: new Date('2026-06-03T00:00:00Z'),
    }] });

    const res = await listGET();
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('WHERE team_id = $1'), ['team_1']);
    expect(payload.presets[0]).toMatchObject({ slug: 'support-bot', model: 'gpt-5.4', enabled: true });
  });

  it('creates preset and version atomically, then invalidates proxy cache', async () => {
    const client = makeClient();

    const res = await createPOST(jsonReq('/api/presets', {
      slug: 'support-bot',
      model: 'gpt-5.4',
      params: { temperature: 0.2, max_tokens: 1024 },
      system_prompt: 'help',
      provider_prefs: { data_collection: 'deny' },
      enabled: true,
    }));
    const payload = await res.json();

    expect(res.status).toBe(201);
    expect(payload).toMatchObject({
      slug: 'support-bot',
      version: 1,
      proxy_cache_invalidated: true,
    });
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO presets'))).toBe(true);
    expect(client.query.mock.calls.some((c) => String(c[0]).includes('INSERT INTO preset_versions'))).toBe(true);
    expect(h.fetch).toHaveBeenCalledWith('https://proxy.test/admin/presets/invalidate', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ team_id: 'team_1' }),
    }));
    expect(client.release).toHaveBeenCalled();
  });

  it('creates and updates presets with a generated effective chat model', async () => {
    expect(GENERATED_CHAT_MODEL).toBeDefined();
    if (!GENERATED_CHAT_MODEL) return;
    const client = makeClient();
    const body = {
      model: GENERATED_CHAT_MODEL.canonical_name,
      params: {},
      system_prompt: 'generated catalog policy',
      provider_prefs: null,
      enabled: true,
    };

    const created = await createPOST(jsonReq('/api/presets', {
      slug: 'generated-policy',
      ...body,
    }));
    expect(created.status).toBe(201);
    expect(client.query.mock.calls.some((call) => (
      String(call[0]).includes('INSERT INTO presets')
      && (call[1] as unknown[]).includes(GENERATED_CHAT_MODEL.canonical_name)
    ))).toBe(true);

    client.query.mockClear();
    const updated = await updatePUT(
      jsonReq('/api/presets/generated-policy', body),
      { params: Promise.resolve({ slug: 'generated-policy' }) },
    );
    expect(updated.status).toBe(200);
    expect(client.query.mock.calls.some((call) => (
      String(call[0]).includes('UPDATE presets')
      && (call[1] as unknown[]).includes(GENERATED_CHAT_MODEL.canonical_name)
    ))).toBe(true);
  });
  it('persists valid reasoning controls and omits unknown params on create and update', async () => {
    const client = makeClient();
    const params = {
      temperature: 0.2,
      max_tokens: 1024,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ['END'],
      reasoning_effort: 'high',
      thinking_level: 'medium',
      thinking_budget_tokens: Number.MAX_SAFE_INTEGER,
      unknown_param: 'drop-me',
    };

    const created = await createPOST(jsonReq('/api/presets', {
      slug: 'support-bot',
      model: 'gpt-5.4',
      params,
      system_prompt: 'help',
      provider_prefs: null,
    }));
    expect(created.status).toBe(201);
    const insertCall = client.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO presets'));
    const insertedParams = (insertCall?.[1] ?? []).find((value) => value && typeof value === 'object' && !Array.isArray(value) && 'temperature' in value);
    expect(insertedParams).toEqual({
      temperature: 0.2,
      max_tokens: 1024,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ['END'],
      reasoning_effort: 'high',
      thinking_level: 'medium',
      thinking_budget_tokens: Number.MAX_SAFE_INTEGER,
    });

    const updated = await updatePUT(jsonReq('/api/presets/support-bot', {
      model: 'gpt-5.4',
      params,
      system_prompt: 'help',
      provider_prefs: null,
    }), { params: Promise.resolve({ slug: 'support-bot' }) });
    expect(updated.status).toBe(200);
    const updateCall = client.query.mock.calls.find((call) => String(call[0]).includes('UPDATE presets'));
    const updatedParams = (updateCall?.[1] ?? []).find((value) => value && typeof value === 'object' && !Array.isArray(value) && 'temperature' in value);
    expect(updatedParams).toEqual({
      temperature: 0.2,
      max_tokens: 1024,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ['END'],
      reasoning_effort: 'high',
      thinking_level: 'medium',
      thinking_budget_tokens: Number.MAX_SAFE_INTEGER,
    });
  });

  it('rejects invalid reasoning enum and budget values before any database work', async () => {
    makeClient();
    const invalidCases: Array<{ key: string; value: unknown; error: string }> = [
      { key: 'reasoning_effort', value: 'urgent', error: 'invalid_reasoning_effort' },
      { key: 'reasoning_effort', value: null, error: 'invalid_reasoning_effort' },
      { key: 'reasoning_effort', value: 1, error: 'invalid_reasoning_effort' },
      { key: 'reasoning_effort', value: [], error: 'invalid_reasoning_effort' },
      { key: 'reasoning_effort', value: {}, error: 'invalid_reasoning_effort' },
      { key: 'thinking_level', value: 'ultra', error: 'invalid_thinking_level' },
      { key: 'thinking_level', value: null, error: 'invalid_thinking_level' },
      { key: 'thinking_level', value: 1, error: 'invalid_thinking_level' },
      { key: 'thinking_level', value: [], error: 'invalid_thinking_level' },
      { key: 'thinking_level', value: {}, error: 'invalid_thinking_level' },
      { key: 'thinking_budget_tokens', value: 0, error: 'invalid_thinking_budget_tokens' },
      { key: 'thinking_budget_tokens', value: -1, error: 'invalid_thinking_budget_tokens' },
      { key: 'thinking_budget_tokens', value: 1.5, error: 'invalid_thinking_budget_tokens' },
      { key: 'thinking_budget_tokens', value: Number.MAX_SAFE_INTEGER + 1, error: 'invalid_thinking_budget_tokens' },
      { key: 'thinking_budget_tokens', value: '4096', error: 'invalid_thinking_budget_tokens' },
      { key: 'thinking_budget_tokens', value: Infinity, error: 'invalid_thinking_budget_tokens' },
      { key: 'thinking_budget_tokens', value: NaN, error: 'invalid_thinking_budget_tokens' },
    ];

    for (const invalidCase of invalidCases) {
      const params = { [invalidCase.key]: invalidCase.value };
      const body = {
        slug: 'support-bot',
        model: 'gpt-5.4',
        params,
        system_prompt: 'help',
        provider_prefs: null,
      };
      const create = await createPOST({ json: async () => body } as unknown as Request);
      expect(create.status, invalidCase.key).toBe(400);
      expect(await create.json(), invalidCase.key).toEqual({ error: invalidCase.error });

      const update = await updatePUT({ json: async () => ({ ...body, slug: undefined }) } as unknown as Request, {
        params: Promise.resolve({ slug: 'support-bot' }),
      });
      expect(update.status, invalidCase.key).toBe(400);
      expect(await update.json(), invalidCase.key).toEqual({ error: invalidCase.error });
    }

    expect(h.connect).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reports a committed create when proxy cache invalidation returns non-OK', async () => {
    const client = makeClient();
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale' }), { status: 503 }));

    const res = await createPOST(jsonReq('/api/presets', {
      slug: 'support-bot',
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
    }));

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      slug: 'support-bot',
      version: 1,
      proxy_cache_invalidated: false,
      proxy_cache_error: 'proxy_cache_invalidation_failed',
      cache_ttl_seconds: 60,
    });
    expect(client.query.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['COMMIT']));
  });

  it('accepts a registered model with an approved RouteShift suffix', async () => {
    const client = makeClient();

    const res = await createPOST(jsonReq('/api/presets', {
      slug: 'support-bot',
      model: 'gpt-5.4:floor',
      params: {},
      system_prompt: null,
      provider_prefs: null,
    }));

    expect(res.status).toBe(201);
    expect(client.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO presets'))?.[1]).toContain('gpt-5.4:floor');
  });

  it('persists data residency preferences through the shared validator', async () => {
    const client = makeClient();

    const res = await createPOST(jsonReq('/api/presets', {
      slug: 'support-bot',
      model: 'gpt-5.4',
      params: {},
      system_prompt: 'help',
      provider_prefs: { data_residency: ['EU-DE'] },
    }));

    expect(res.status).toBe(201);
    const insertCall = client.query.mock.calls.find((call) => String(call[0]).includes('INSERT INTO presets'));
    const prefsParam = (insertCall?.[1] ?? []).find((value) => value !== null && typeof value === 'object' && 'data_residency' in value);
    expect(prefsParam).toEqual({ data_residency: ['EU-DE'] });
  });

  it('rejects malformed residency codes with the exact shared reason', async () => {
    const client = makeClient();

    const res = await createPOST(jsonReq('/api/presets', {
      slug: 'support-bot',
      model: 'gpt-5.4',
      params: {},
      system_prompt: 'help',
      provider_prefs: { data_residency: ['EUROPE'] },
    }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_provider_prefs' });
    expect(client.query).not.toHaveBeenCalled();
  });

  it('persists residency preferences on update and rejects malformed ones before any write', async () => {
    const client = makeClient();

    const updated = await updatePUT(jsonReq('/api/presets/support-bot', {
      model: 'gpt-5.4',
      params: {},
      system_prompt: 'help',
      provider_prefs: { data_residency: ['EU-DE'], data_collection: 'deny' },
    }), { params: Promise.resolve({ slug: 'support-bot' }) });

    expect(updated.status).toBe(200);
    const updateCall = client.query.mock.calls.find((call) => String(call[0]).includes('UPDATE presets'));
    const prefsParam = (updateCall?.[1] ?? []).find((value) => value !== null && typeof value === 'object' && 'data_residency' in value);
    expect(prefsParam).toEqual({ data_residency: ['EU-DE'], data_collection: 'deny' });

    const rejected = await updatePUT(jsonReq('/api/presets/support-bot', {
      model: 'gpt-5.4',
      params: {},
      system_prompt: 'help',
      provider_prefs: { data_residency: ['EUROPE'] },
    }), { params: Promise.resolve({ slug: 'support-bot' }) });

    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: 'invalid_provider_prefs' });
    expect(client.query.mock.calls.filter((call) => String(call[0]).includes('UPDATE presets'))).toHaveLength(1);
  });

  it('publishes updates as a new version in one transaction', async () => {
    const client = makeClient();

    const res = await updatePUT(
      jsonReq('/api/presets/support-bot', {
        model: 'gpt-5.5',
        params: { temperature: 0.1 },
        system_prompt: 'updated help',
        provider_prefs: { order: ['azure'], data_collection: 'deny' },
      }),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload).toMatchObject({
      slug: 'support-bot',
      version: 2,
      proxy_cache_invalidated: true,
    });
    const sql = client.query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).toContain('UPDATE presets');
    expect(sql).toContain('version = version + 1');
    expect(sql).toContain('INSERT INTO preset_versions');
    expect(client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE presets'))?.[1]).toContain('team_1');
  });

  it('reports a committed update when proxy cache invalidation has a network failure', async () => {
    const client = makeClient();
    h.fetch.mockRejectedValueOnce(new Error('proxy unavailable'));

    const res = await updatePUT(
      jsonReq('/api/presets/support-bot', {
        model: 'gpt-5.5',
        params: {},
        system_prompt: null,
        provider_prefs: null,
      }),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      slug: 'support-bot',
      version: 2,
      proxy_cache_invalidated: false,
      proxy_cache_error: 'proxy_cache_invalidation_failed',
      cache_ttl_seconds: 60,
    });
    expect(client.query.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['COMMIT']));
  });

  it('preserves enabled state on update unless explicitly provided', async () => {
    const client = makeClient();

    await updatePUT(
      jsonReq('/api/presets/support-bot', {
        model: 'gpt-5.5',
        params: { temperature: 0.1 },
        system_prompt: 'updated help',
        provider_prefs: null,
      }),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );

    const updateCall = client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE presets'));
    expect(String(updateCall?.[0])).toContain('enabled = COALESCE($7, enabled)');
    expect(updateCall?.[1]).toContain(null);
  });

  it('requires the explicit disable endpoint instead of publishing a disabled version', async () => {
    const res = await updatePUT(
      jsonReq('/api/presets/support-bot', {
        model: 'gpt-5.5',
        params: {},
        system_prompt: null,
        provider_prefs: null,
        enabled: false,
      }),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'preset_disable_requires_disable_endpoint' });
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('rejects invalid or partial preset update bodies', async () => {
    const create = await createPOST(jsonReq('/api/presets', null));
    const update = await updatePUT(jsonReq('/api/presets/support-bot', null), {
      params: Promise.resolve({ slug: 'support-bot' }),
    });
    const partialUpdate = await updatePUT(jsonReq('/api/presets/support-bot', {
      model: 'gpt-5.5',
      params: {},
    }), {
      params: Promise.resolve({ slug: 'support-bot' }),
    });

    expect(create.status).toBe(400);
    expect(update.status).toBe(400);
    expect(partialUpdate.status).toBe(400);
    expect(await partialUpdate.json()).toEqual({ error: 'full_preset_body_required' });
  });

  it('detail and disable routes are team-scoped by slug', async () => {
    h.query.mockResolvedValueOnce({ rows: [{ slug: 'support-bot', version: 1, model: 'gpt-5.4', params: {}, system_prompt: null, provider_prefs: null, enabled: true, updated_at: new Date() }] });
    const detail = await detailGET(new Request('https://app.test/api/presets/support-bot'), { params: Promise.resolve({ slug: 'support-bot' }) });
    expect(detail.status).toBe(200);
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining('WHERE team_id = $1 AND slug = $2'), ['team_1', 'support-bot']);

    const client = makeClient();
    const disabled = await deletePreset(new Request('https://app.test/api/presets/support-bot?disable=true'), { params: Promise.resolve({ slug: 'support-bot' }) });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ ok: true, disabled: true, proxy_cache_invalidated: true });
    expect(client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE presets'))?.[1]).toEqual(['team_1', 'support-bot']);
  });

  it('reports a committed disable when proxy cache invalidation returns non-OK', async () => {
    const client = makeClient();
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'stale' }), { status: 503 }));

    const res = await deletePreset(
      new Request('https://app.test/api/presets/support-bot?disable=true'),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      disabled: true,
      proxy_cache_invalidated: false,
      proxy_cache_error: 'proxy_cache_invalidation_failed',
      cache_ttl_seconds: 60,
    });
    expect(client.query.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['COMMIT']));
  });

  it('lists immutable preset versions newest first for the effective team', async () => {
    h.query.mockResolvedValueOnce({ rows: [
      {
        version: 2,
        model: 'gpt-5.5',
        params: { temperature: 0.1 },
        system_prompt: 'updated help',
        provider_prefs: { order: ['azure'] },
        created_by: 'user_1',
        created_at: new Date('2026-06-04T00:00:00Z'),
      },
      {
        version: 1,
        model: 'gpt-5.4',
        params: { temperature: 0.2 },
        system_prompt: 'help',
        provider_prefs: null,
        created_by: 'user_1',
        created_at: new Date('2026-06-03T00:00:00Z'),
      },
    ] });

    const res = await versionsGET(
      new Request('https://app.test/api/presets/support-bot/versions'),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload).toEqual({ versions: [
      {
        version: 2,
        model: 'gpt-5.5',
        params: { temperature: 0.1 },
        system_prompt: 'updated help',
        provider_prefs: { order: ['azure'] },
        created_by: 'user_1',
        created_at: '2026-06-04T00:00:00.000Z',
      },
      {
        version: 1,
        model: 'gpt-5.4',
        params: { temperature: 0.2 },
        system_prompt: 'help',
        provider_prefs: null,
        created_by: 'user_1',
        created_at: '2026-06-03T00:00:00.000Z',
      },
    ] });
    const [sql, params] = h.query.mock.calls[0];
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
    expect(normalizedSql).toContain(
      'FROM preset_versions pv JOIN presets p ON p.id = pv.preset_id AND p.team_id = pv.team_id '
      + 'WHERE pv.team_id = $1 AND p.team_id = $1 AND p.slug = $2 ORDER BY pv.version DESC',
    );
    expect(params).toEqual(['team_1', 'support-bot']);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('returns one immutable preset version using a numeric query parameter', async () => {
    h.query.mockResolvedValueOnce({ rows: [{
      version: 2,
      model: 'gpt-5.5',
      params: { temperature: 0.1 },
      system_prompt: 'updated help',
      provider_prefs: { order: ['azure'] },
      created_by: 'user_1',
      created_at: new Date('2026-06-04T00:00:00Z'),
    }] });

    const res = await versionGET(
      new Request('https://app.test/api/presets/support-bot/versions/2'),
      { params: Promise.resolve({ slug: 'support-bot', version: '2' }) },
    );
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload).toEqual({ version: {
      version: 2,
      model: 'gpt-5.5',
      params: { temperature: 0.1 },
      system_prompt: 'updated help',
      provider_prefs: { order: ['azure'] },
      created_by: 'user_1',
      created_at: '2026-06-04T00:00:00.000Z',
    } });
    const [sql, params] = h.query.mock.calls[0];
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
    expect(normalizedSql).toContain(
      'FROM preset_versions pv JOIN presets p ON p.id = pv.preset_id AND p.team_id = pv.team_id '
      + 'WHERE pv.team_id = $1 AND p.team_id = $1 AND p.slug = $2 AND pv.version = $3 LIMIT 1',
    );
    expect(params).toEqual(['team_1', 'support-bot', 2]);
  });

  it('rejects malformed preset slugs in both history routes before querying', async () => {
    const list = await versionsGET(
      new Request('https://app.test/api/presets/..%2Fbad/versions'),
      { params: Promise.resolve({ slug: '../bad' }) },
    );
    const single = await versionGET(
      new Request('https://app.test/api/presets/..%2Fbad/versions/1'),
      { params: Promise.resolve({ slug: '../bad', version: '1' }) },
    );

    expect(list.status).toBe(400);
    expect(single.status).toBe(400);
    expect(await list.json()).toEqual({ error: 'invalid_preset_slug' });
    expect(await single.json()).toEqual({ error: 'invalid_preset_slug' });
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', '2oops', '2147483648'])(
    'rejects malformed or out-of-range preset version %s before querying',
    async (version) => {
      const res = await versionGET(
        new Request(`https://app.test/api/presets/support-bot/versions/${version}`),
        { params: Promise.resolve({ slug: 'support-bot', version }) },
      );

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_preset_version' });
      expect(h.query).not.toHaveBeenCalled();
    },
  );

  it('returns the same not-found response for cross-team and missing snapshots', async () => {
    const snapshot = {
      version: 1,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
      created_by: 'user_1',
      created_at: new Date('2026-06-03T00:00:00Z'),
    };
    h.query.mockImplementation(async (_sql: string, params?: unknown[]) => ({
      rows: params?.[0] === 'team_1' && params?.[1] === 'support-bot'
        ? [snapshot]
        : [],
    }));

    const owner = await versionGET(
      new Request('https://app.test/api/presets/support-bot/versions/1'),
      { params: Promise.resolve({ slug: 'support-bot', version: '1' }) },
    );
    expect(owner.status).toBe(200);

    h.member = { userId: 'user_2', teamId: 'team_2', role: 'member' };
    const crossTeam = await versionGET(
      new Request('https://app.test/api/presets/support-bot/versions/1'),
      { params: Promise.resolve({ slug: 'support-bot', version: '1' }) },
    );
    const crossTeamBody = await crossTeam.json();
    expect(h.query.mock.calls[1]?.[1]).toEqual(['team_2', 'support-bot', 1]);

    h.member = { userId: 'user_1', teamId: 'team_1', role: 'admin' };
    const missing = await versionGET(
      new Request('https://app.test/api/presets/missing/versions/1'),
      { params: Promise.resolve({ slug: 'missing', version: '1' }) },
    );
    const missingBody = await missing.json();

    expect(crossTeam.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(crossTeamBody).toEqual({ error: 'preset_not_found' });
    expect(missingBody).toEqual(crossTeamBody);
  });

  it('requires a session before reading preset history', async () => {
    h.member = null;

    const res = await versionsGET(
      new Request('https://app.test/api/presets/support-bot/versions'),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(h.query).not.toHaveBeenCalled();
  });

  it('substitutes the demo team for every preset read', async () => {
    h.demoActive = true;
    h.query.mockResolvedValue({ rows: [] });

    const list = await listGET();
    const detail = await detailGET(
      new Request('https://app.test/api/presets/support-bot'),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );
    const history = await versionsGET(
      new Request('https://app.test/api/presets/support-bot/versions'),
      { params: Promise.resolve({ slug: 'support-bot' }) },
    );
    const snapshot = await versionGET(
      new Request('https://app.test/api/presets/support-bot/versions/1'),
      { params: Promise.resolve({ slug: 'support-bot', version: '1' }) },
    );

    expect(list.status).toBe(200);
    expect(detail.status).toBe(404);
    expect(history.status).toBe(404);
    expect(snapshot.status).toBe(404);
    expect(h.query.mock.calls.map((call) => call[1]?.[0])).toEqual([
      'team_demo',
      'team_demo',
      'team_demo',
      'team_demo',
    ]);
  });
});
