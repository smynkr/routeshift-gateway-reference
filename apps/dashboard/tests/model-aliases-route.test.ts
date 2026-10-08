import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG_FRESHNESS_MANIFEST,
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  EFFECTIVE_PUBLIC_MODELS,
  GOOGLE_PREVIEW_QUARANTINE_IDS,
  MODEL_REGISTRY,
} from '@routeshift/shared';

const h = vi.hoisted(() => ({
  member: { userId: 'user_1', teamId: 'team_1', role: 'admin' } as {
    userId: string;
    teamId: string;
    role: string;
  } | null,
  query: vi.fn(),
  fetch: vi.fn(),
  demoActive: false,
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: async () => h.member,
  requireRole: async () => h.member?.role === 'admin' ? h.member : null,
}));
vi.mock('@/lib/db', () => ({
  getPool: () => ({ query: h.query }),
}));
vi.mock('@/lib/demo', () => ({
  isDemoActive: async () => h.demoActive,
  getEffectiveTeamId: async (teamId: string | null | undefined) => teamId ?? null,
  DEMO_WRITE_BLOCKED_MESSAGE: 'Demo mode is read-only.',
}));
vi.mock('@/lib/proxy', () => ({
  PROXY_URL: 'https://proxy.test',
  adminHeaders: (extra: Record<string, string> = {}) => ({ ...extra, Authorization: 'Bearer admin' }),
}));

import { POST } from '@/app/api/model-aliases/route';

const generatedChat = EFFECTIVE_DISPATCHABLE_CHAT_MODELS.find((model) => (
  'source' in model && model.source === 'generated'
));
const embedding = EFFECTIVE_PUBLIC_MODELS.find((model) => (
  'kind' in model && model.kind === 'embedding'
));
const alternateApiId = EFFECTIVE_PUBLIC_MODELS.find((model) => (
  model.api_model_id !== model.canonical_name
));

function request(body: unknown): Request {
  return new Request('https://app.test/api/model-aliases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.member = { userId: 'user_1', teamId: 'team_1', role: 'admin' };
  h.demoActive = false;
  h.query.mockReset();
  h.fetch.mockReset();
  h.query.mockResolvedValue({ rows: [], rowCount: 1 });
  h.fetch.mockResolvedValue(new Response(JSON.stringify({ invalidated: true }), { status: 200 }));
  vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
});

describe('model alias effective catalog validation', () => {
  it('round-trips an alias whose target is a generated dispatchable chat model', async () => {
    expect(generatedChat).toBeDefined();
    if (!generatedChat) return;

    const response = await POST(request({
      alias: 'generated-chat-target',
      canonical_name: generatedChat.canonical_name,
      notes: 'generated catalog target',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      alias: 'generated-chat-target',
      canonical_name: generatedChat.canonical_name,
    });
    expect(h.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO model_aliases'),
      ['team_1', 'generated-chat-target', generatedChat.canonical_name, 'generated catalog target'],
    );
  });

  it('reserves effective API IDs from alias names so they cannot shadow provider models', async () => {
    expect(alternateApiId).toBeDefined();
    expect(generatedChat).toBeDefined();
    if (!alternateApiId || !generatedChat) return;

    const response = await POST(request({
      alias: alternateApiId.api_model_id,
      canonical_name: generatedChat.canonical_name,
    }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/collides with an effective model id/i);
    expect(h.query).not.toHaveBeenCalled();
  });
  it('reserves hidden curated IDs such as gpt-5.6-cyber from alias names', async () => {
    const hiddenCurated = MODEL_REGISTRY.find((model) => model.canonical_name === 'gpt-5.6-cyber');
    expect(hiddenCurated).toBeDefined();
    if (!hiddenCurated) return;

    const response = await POST(request({
      alias: hiddenCurated.api_model_id,
      canonical_name: generatedChat?.canonical_name ?? 'gpt-5.5',
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/collides with .*model id/i);
    expect(h.query).not.toHaveBeenCalled();
  });
  it('reserves Google preview quarantine IDs from alias names', async () => {
    const quarantinedId = GOOGLE_PREVIEW_QUARANTINE_IDS[0];
    expect(quarantinedId).toBeDefined();

    const response = await POST(request({
      alias: quarantinedId,
      canonical_name: generatedChat?.canonical_name ?? 'gpt-5.5',
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/collides with .*model id/i);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('reserves every quarantined model id, including provider-specific ids with any reason', async () => {
    const quarantinedModelIds = CATALOG_FRESHNESS_MANIFEST.quarantined
      .filter((entry) => entry.kind === 'model')
      .map((entry) => entry.model);

    expect(quarantinedModelIds).toContain('us.openai.gpt-5.6-sol');
    expect(generatedChat).toBeDefined();
    if (!generatedChat) return;

    for (const modelId of quarantinedModelIds) {
      const response = await POST(request({
        alias: modelId,
        canonical_name: generatedChat.canonical_name,
      }));

      expect(response.status, `quarantined model id ${modelId}`).toBe(400);
      expect((await response.json()).error).toMatch(/collides with .*model id/i);
    }
    expect(h.query).not.toHaveBeenCalled();
  });

  it('rejects an embedding row as an alias target', async () => {
    expect(embedding).toBeDefined();
    if (!embedding) return;

    const response = await POST(request({
      alias: 'embedding-is-not-chat',
      canonical_name: embedding.canonical_name,
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/dispatchable chat model/i);
    expect(h.query).not.toHaveBeenCalled();
  });
});
