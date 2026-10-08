// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EFFECTIVE_DISPATCHABLE_CHAT_MODELS, MODEL_REGISTRY } from '@routeshift/shared';
import { PresetsManager } from '@/components/presets/presets-manager';

const residencyMock = vi.hoisted(() => ({ endpoints: null as Array<Record<string, unknown>> | null }));

vi.mock('@routeshift/shared', async () => {
  const actual = await vi.importActual<typeof import('@routeshift/shared')>('@routeshift/shared');
  return {
    ...actual,
    getModelEndpoints: (model: string) =>
      (residencyMock.endpoints ?? actual.getModelEndpoints(model)) as unknown as ReturnType<typeof actual.getModelEndpoints>,
  };
});


const GENERATED_CHAT_MODEL = EFFECTIVE_DISPATCHABLE_CHAT_MODELS.find((model) => (
  'source' in model
  && model.source === 'generated'
  && model.canonical_name.includes(':')
  && !MODEL_REGISTRY.some((entry) => entry.canonical_name === model.canonical_name)
));
const fetchMock = vi.fn();

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  residencyMock.endpoints = null;
  vi.unstubAllGlobals();
});

describe('PresetsManager', () => {
  it('lists presets from the authenticated dashboard API', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      presets: [{
        slug: 'support-bot',
        version: 3,
        model: 'gpt-5.4',
        params: { temperature: 0.2 },
        system_prompt: 'Be concise.',
        provider_prefs: null,
        enabled: true,
        updated_at: '2026-07-10T00:00:00.000Z',
      }],
    }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    expect(await screen.findByText('support-bot')).toBeTruthy();
    expect(screen.getByText('gpt-5.4')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/presets', expect.objectContaining({ cache: 'no-store' }));
  });

  it('blocks an invalid preset slug in the client before sending a POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'Not valid' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    expect((await screen.findByRole('alert')).textContent).toContain('invalid_preset_slug');
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET']);
  });

  it('blocks an unknown model in the client before sending a POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'support-bot' } });
    const modelInput = screen.getByLabelText('Model');
    fireEvent.change(modelInput, { target: { value: 'unknown-model' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    expect((await screen.findByRole('alert')).textContent).toContain('invalid_preset_model');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('creates a preset through the dashboard API and refreshes the real list', async () => {
    const created = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'preset_1', slug: 'support-bot', version: 1 }, 201))
      .mockResolvedValueOnce(jsonResponse({ presets: [created] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'support-bot' } });
    const modelInput = screen.getByLabelText('Model');
    fireEvent.change(modelInput, { target: { value: 'gpt-5.4' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      slug: 'support-bot',
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
    });
    expect(await screen.findByText('support-bot')).toBeTruthy();
  });

  it('creates a preset with a generated effective chat model selected in the editor', async () => {
    expect(GENERATED_CHAT_MODEL).toBeDefined();
    if (!GENERATED_CHAT_MODEL) return;
    const created = {
      slug: 'generated-policy',
      model: GENERATED_CHAT_MODEL.canonical_name,
      params: {},
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-08-27T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'preset_generated', slug: created.slug, version: 1 }, 201))
      .mockResolvedValueOnce(jsonResponse({ presets: [created] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: created.slug } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: GENERATED_CHAT_MODEL.canonical_name } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      slug: created.slug,
      model: GENERATED_CHAT_MODEL.canonical_name,
    });
  });

  it('allows a registered model with an approved RouteShift suffix', async () => {
    const created = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4:floor',
      params: {},
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'preset_1', slug: 'support-bot', version: 1 }, 201))
      .mockResolvedValueOnce(jsonResponse({ presets: [created] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'support-bot' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.4:floor' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toMatchObject({
      model: 'gpt-5.4:floor',
    });
    expect(await screen.findByText('gpt-5.4:floor')).toBeTruthy();
  });

  it('publishes an edit as a new version with the complete PUT body', async () => {
    const preset = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: { temperature: 0.2, max_tokens: 512 },
      system_prompt: 'Be concise.',
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ slug: 'support-bot', version: 2 }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, version: 2, system_prompt: 'Be very concise.' }] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit support-bot' }));
    expect(screen.queryByLabelText('Enable this preset after publishing')).toBeNull();
    expect(screen.getByText('Use the preset table’s Disable action to stop resolution without publishing a new version.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'Be very concise.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets/support-bot');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-5.4',
      params: { temperature: 0.2, max_tokens: 512 },
      system_prompt: 'Be very concise.',
      provider_prefs: null,
    });
    expect(await screen.findByText('v2')).toBeTruthy();
  });
  it('hydrates valid reasoning controls and round-trips them when publishing an edit', async () => {
    const preset = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {
        temperature: 0.2,
        max_tokens: 512,
        reasoning_effort: 'high',
        thinking_level: 'medium',
        thinking_budget_tokens: 4096,
      },
      system_prompt: 'Be concise.',
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ slug: 'support-bot', version: 2 }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, version: 2 }] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit support-bot' }));
    expect((screen.getByLabelText('Reasoning effort') as HTMLSelectElement).value).toBe('high');
    expect((screen.getByLabelText('Thinking level') as HTMLSelectElement).value).toBe('medium');
    expect((screen.getByLabelText('Thinking budget tokens') as HTMLInputElement).value).toBe('4096');
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets/support-bot');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-5.4',
      params: {
        temperature: 0.2,
        max_tokens: 512,
        reasoning_effort: 'high',
        thinking_level: 'medium',
        thinking_budget_tokens: 4096,
      },
      system_prompt: 'Be concise.',
      provider_prefs: null,
    });
  });

  it('includes selected reasoning controls in a newly created preset', async () => {
    const created = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {
        reasoning_effort: 'low',
        thinking_level: 'minimal',
        thinking_budget_tokens: 2048,
      },
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'preset_1', slug: 'support-bot', version: 1 }, 201))
      .mockResolvedValueOnce(jsonResponse({ presets: [created] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'support-bot' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.4' } });
    fireEvent.keyDown(screen.getByLabelText('Model'), { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'low' } });
    fireEvent.change(screen.getByLabelText('Thinking level'), { target: { value: 'minimal' } });
    fireEvent.change(screen.getByLabelText('Thinking budget tokens'), { target: { value: '2048' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      params: {
        reasoning_effort: 'low',
        thinking_level: 'minimal',
        thinking_budget_tokens: 2048,
      },
    });
  });
  it('omits blank provider-default reasoning controls from a create POST', async () => {
    const created = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'preset_1', slug: 'support-bot', version: 1 }, 201))
      .mockResolvedValueOnce(jsonResponse({ presets: [created] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    expect((screen.getByLabelText('Reasoning effort') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Thinking level') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Thinking budget tokens') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'support-bot' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.4' } });
    fireEvent.keyDown(screen.getByLabelText('Model'), { key: 'Enter' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      params: {},
    });
    expect(JSON.parse(String(init.body)).params).not.toHaveProperty('reasoning_effort');
    expect(JSON.parse(String(init.body)).params).not.toHaveProperty('thinking_level');
    expect(JSON.parse(String(init.body)).params).not.toHaveProperty('thinking_budget_tokens');
  });

  it('shows the exact client error for an invalid thinking budget without posting', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'support-bot' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'gpt-5.4' } });
    fireEvent.keyDown(screen.getByLabelText('Model'), { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('Thinking budget tokens'), { target: { value: '0' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    expect((await screen.findByRole('alert')).textContent).toBe('invalid_thinking_budget_tokens');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces all malformed stored reasoning fields and blocks publishing until each is corrected', async () => {
    const preset = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {
        reasoning_effort: 'urgent',
        thinking_level: 'ultra',
        thinking_budget_tokens: '4096',
      },
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ presets: [preset] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit support-bot' }));
    expect((screen.getByLabelText('Reasoning effort') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Thinking level') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Thinking budget tokens') as HTMLInputElement).value).toBe('');
    const status = screen.getByRole('status').textContent ?? '';
    expect(status).toContain('invalid_reasoning_effort');
    expect(status).toContain('invalid_thinking_level');
    expect(status).toContain('invalid_thinking_budget_tokens');

    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect((await screen.findByRole('alert')).textContent).toBe('invalid_thinking_level');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Thinking level'), { target: { value: 'medium' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect((await screen.findByRole('alert')).textContent).toBe('invalid_thinking_budget_tokens');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });


  it('resets the editor draft when switching between presets before publishing', async () => {
    const first = {
      slug: 'first-bot', version: 1, model: 'gpt-5.4', params: {}, system_prompt: 'First original.',
      provider_prefs: null, enabled: true, updated_at: '2026-07-10T00:00:00.000Z',
    };
    const second = {
      slug: 'second-bot', version: 3, model: 'gpt-5.5', params: {}, system_prompt: 'Second original.',
      provider_prefs: null, enabled: true, updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [first, second] }))
      .mockResolvedValueOnce(jsonResponse({ slug: 'second-bot', version: 4 }))
      .mockResolvedValueOnce(jsonResponse({ presets: [first, { ...second, version: 4 }] }));

    render(
      <PresetsManager canManage demo={false} readOnlyReason="Only admins can manage team presets." />,
    );

    await screen.findByText('first-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit first-bot' }));
    fireEvent.change(screen.getByLabelText('System prompt'), { target: { value: 'First unsaved edit.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit second-bot' }));

    expect((screen.getByLabelText('System prompt') as HTMLTextAreaElement).value).toBe('Second original.');
    fireEvent.click(screen.getByRole('button', { name: 'Publish v4' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets/second-bot');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.5',
      system_prompt: 'Second original.',
    });
  });

  it('disables both cancel affordances while a publish request is in flight', async () => {
    const preset = {
      slug: 'support-bot', version: 1, model: 'gpt-5.4', params: {}, system_prompt: null,
      provider_prefs: null, enabled: true, updated_at: '2026-07-10T00:00:00.000Z',
    };
    let resolvePublish: ((response: Response) => void) | undefined;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolvePublish = resolve; }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, version: 2 }] }));

    render(
      <PresetsManager canManage demo={false} readOnlyReason="Only admins can manage team presets." />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit support-bot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }));

    await waitFor(() => {
      const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
      expect(cancelButtons).toHaveLength(2);
      expect(cancelButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    });

    resolvePublish?.(jsonResponse({ slug: 'support-bot', version: 2 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  });

  it('validates provider preferences before a write and preserves the draft on the exact API error', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [] }))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_provider_prefs' }, 400));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'support-bot' } });
    const modelInput = screen.getByLabelText('Model');
    fireEvent.change(modelInput, { target: { value: 'gpt-5.4' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText(/Provider allowlist/), { target: { value: 'not-a-provider' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    expect((await screen.findByRole('alert')).textContent).toContain('invalid_provider_prefs');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(/Provider allowlist/), { target: { value: 'openai' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole('alert')).textContent).toBe('invalid_provider_prefs');
    expect((screen.getByLabelText('Preset slug') as HTMLInputElement).value).toBe('support-bot');
    expect((screen.getByLabelText(/Provider allowlist/) as HTMLInputElement).value).toBe('openai');
  });

  it('preserves a stored data residency preference across edit and publish round-trips', async () => {
    const preset = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { data_residency: ['EU-DE'], data_collection: 'deny' },
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ slug: 'support-bot', version: 2 }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, version: 2 }] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit support-bot' }));
    expect((screen.getByLabelText(/Data residency/) as HTMLInputElement).value).toBe('EU-DE');
    expect(screen.getByText(/Fail-closed:/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets/support-bot');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({
      provider_prefs: { data_residency: ['EU-DE'], data_collection: 'deny' },
    });
  });

  it('writes canonical residency codes unchanged into the created preset', async () => {
    const created = {
      slug: 'eu-only',
      version: 1,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { data_residency: ['EU-DE', 'US'] },
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'preset_1', slug: 'eu-only', version: 1 }, 201))
      .mockResolvedValueOnce(jsonResponse({ presets: [created] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    expect(screen.queryByText(/Fail-closed:/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'eu-only' } });
    const modelInput = screen.getByLabelText('Model');
    fireEvent.change(modelInput, { target: { value: 'gpt-5.4' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText(/Data residency/), { target: { value: 'EU-DE, US, EU-DE' } });
    // RSH-164 review round: the catalog still declares zero residency
    // evidence, so EU-DE,US remains unsatisfiable and the fail-closed
    // advisory stays (pinned here and by provider-preferences.test.ts).
    expect(screen.getByText(/Fail-closed:/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      provider_prefs: { data_residency: ['EU-DE', 'US'] },
    });
  });
  it('shows no residency warning for delimiter-only input that builds to no preference', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText(/Data residency/), { target: { value: ', ,' } });

    expect(screen.queryByText(/Fail-closed:/)).toBeNull();
  });

  it('warns for typed residency codes before a model is chosen (fail-closed advisory direction)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText(/Data residency/), { target: { value: 'EU-DE' } });

    expect(screen.getByText(/Fail-closed:/)).toBeTruthy();
  });

  it('clears a stored residency preference by blanking the field and publishing', async () => {
    const preset = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { data_residency: ['EU-DE'] },
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ slug: 'support-bot', version: 2 }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, version: 2, provider_prefs: null }] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit support-bot' }));
    expect((screen.getByLabelText(/Data residency/) as HTMLInputElement).value).toBe('EU-DE');
    fireEvent.change(screen.getByLabelText(/Data residency/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets/support-bot');
    expect(JSON.parse(String(init.body))).toMatchObject({ provider_prefs: null });
  });

  it('warns when stored provider preferences are unparseable instead of silently blanking them', async () => {
    const preset = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: { data_residency: ['lowercase-code'] },
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ slug: 'support-bot', version: 2 }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, version: 2, provider_prefs: { data_collection: 'deny' } }] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit support-bot' }));
    expect((screen.getByLabelText(/Data residency/) as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/unparseable/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Data collection'), { target: { value: 'deny' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish v2' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      provider_prefs: { data_collection: 'deny' },
    });
  });

  it('blocks a malformed residency code in the client before sending a POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'eu-only' } });
    const modelInput = screen.getByLabelText('Model');
    fireEvent.change(modelInput, { target: { value: 'gpt-5.4' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText(/Data residency/), { target: { value: 'eu-de' } });
    expect(screen.getByText(/Invalid residency codes/)).toBeTruthy();
    expect((screen.getByLabelText(/Data residency/) as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);

    expect((await screen.findByRole('alert')).textContent).toContain('invalid_provider_prefs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('suppresses the residency warning when the selected model has an endpoint with current verified evidence', async () => {
    residencyMock.endpoints = [{
      provider: 'azure',
      model: 'gpt-5.4',
      zdr: true,
      jurisdictions: ['EU-DE'],
      jurisdiction_evidence: {
        source: 'provider_legal_review',
        status: 'verified',
        verified_at: '2026-01-01T00:00:00.000Z',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('No presets yet');
    fireEvent.click(screen.getAllByRole('button', { name: 'Create preset' }).at(-1)!);
    fireEvent.change(screen.getByLabelText('Preset slug'), { target: { value: 'eu-only' } });
    const modelInput = screen.getByLabelText('Model');
    fireEvent.change(modelInput, { target: { value: 'gpt-5.4' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText(/Data residency/), { target: { value: 'EU-DE' } });

    expect(screen.queryByText(/Fail-closed:/)).toBeNull();
    expect(screen.queryByText(/Invalid residency codes/)).toBeNull();
  });

  it('disables a preset through the explicit disable endpoint', async () => {
    const preset = {
      slug: 'support-bot',
      version: 2,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, disabled: true }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, enabled: false }] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Disable support-bot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm disable support-bot' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets/support-bot?disable=true');
    expect(init.method).toBe('DELETE');
    expect(await screen.findByText('Disabled')).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Presets' })));
  });

  it('shows the exact stale-cache warning when a saved preset change is only partially applied', async () => {
    const preset = {
      slug: 'support-bot', version: 2, model: 'gpt-5.4', params: {}, system_prompt: null,
      provider_prefs: null, enabled: true, updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        disabled: true,
        proxy_cache_invalidated: false,
        proxy_cache_error: 'proxy_cache_invalidation_failed',
        cache_ttl_seconds: 60,
      }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, enabled: false }] }));

    render(
      <PresetsManager canManage demo={false} readOnlyReason="Only admins can manage team presets." />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Disable support-bot' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm disable support-bot' }));

    expect((await screen.findByRole('status')).textContent).toContain('proxy_cache_invalidation_failed');
    expect(screen.getByRole('status').textContent).toContain('for up to 60 seconds');
  });

  it('requires confirmation before deleting a preset and never substitutes the disable endpoint', async () => {
    const preset = {
      slug: 'support-bot',
      version: 2,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Delete support-bot' }));
    expect(screen.getByRole('alertdialog').textContent).toContain('Delete support-bot?');
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete support-bot' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets/support-bot');
    expect(init.method).toBe('DELETE');
    expect(await screen.findByText('No presets yet')).toBeTruthy();
  });

  it('re-enables by publishing a full new version, never through a symmetric delete toggle', async () => {
    const preset = {
      slug: 'support-bot',
      version: 2,
      model: 'gpt-5.4',
      params: { temperature: 0.1 },
      system_prompt: 'Be concise.',
      provider_prefs: null,
      enabled: false,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ slug: 'support-bot', version: 3 }))
      .mockResolvedValueOnce(jsonResponse({ presets: [{ ...preset, version: 3, enabled: true }] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Enable and publish support-bot version 3' }));
    expect(screen.getByText('Re-enabling publishes a new version; it is not a symmetric status toggle.')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Enable & publish v3' }).at(-1)!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/presets/support-bot');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({ enabled: true, model: 'gpt-5.4', params: { temperature: 0.1 } });
    expect(fetchMock.mock.calls.some(([request, options]) => String(request).includes('disable=false') || (options as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('opens an accessible, read-only history dialog with newest-first snapshots and a diff', async () => {
    const preset = {
      slug: 'support-bot',
      version: 2,
      model: 'gpt-5.4',
      params: { temperature: 0.2 },
      system_prompt: 'Be concise.',
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    const versions = [
      { version: 2, model: 'gpt-5.4', params: { temperature: 0.2 }, system_prompt: 'Be concise.', provider_prefs: null, created_by: 'user_1', created_at: '2026-07-10T00:00:00.000Z' },
      { version: 1, model: 'gpt-5.4', params: { temperature: 0.1 }, system_prompt: 'Be brief.', provider_prefs: null, created_by: 'user_1', created_at: '2026-07-09T00:00:00.000Z' },
    ];
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ versions }))
      .mockResolvedValueOnce(jsonResponse({ version: versions[0] }));

    render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    const historyButton = screen.getByRole('button', { name: 'View history for support-bot' });
    fireEvent.click(historyButton);

    const dialog = await screen.findByRole('dialog', { name: 'Version history for support-bot' });
    expect(await screen.findByText('Changed from v1')).toBeTruthy();
    expect(dialog.textContent).toContain('System prompt changed');
    expect(screen.getAllByRole('button', { name: /View version/ }).map((button) => button.getAttribute('aria-label'))).toEqual([
      'View version 2',
      'View version 1',
    ]);
    expect(screen.queryByRole('button', { name: /rollback/i })).toBeNull();
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/presets/support-bot/versions');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/presets/support-bot/versions/2');

    const closeButton = screen.getByRole('button', { name: 'Close version history' });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(historyButton));
  });

  it('keeps the currently selected version snapshot when an older response resolves late', async () => {
    const preset = {
      slug: 'support-bot', version: 2, model: 'gpt-5.4', params: {}, system_prompt: null,
      provider_prefs: null, enabled: true, updated_at: '2026-07-10T00:00:00.000Z',
    };
    const versions = [
      { version: 2, model: 'gpt-5.4', params: { temperature: 0.2 }, system_prompt: 'Second.', provider_prefs: null, created_by: 'user_1', created_at: '2026-07-10T00:00:00.000Z' },
      { version: 1, model: 'gpt-5.4', params: { temperature: 0.1 }, system_prompt: 'First.', provider_prefs: null, created_by: 'user_1', created_at: '2026-07-09T00:00:00.000Z' },
    ];
    let resolveV1: ((response: Response) => void) | undefined;
    let resolveV2: ((response: Response) => void) | undefined;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [preset] }))
      .mockResolvedValueOnce(jsonResponse({ versions }))
      .mockResolvedValueOnce(jsonResponse({ version: versions[0] }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveV1 = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveV2 = resolve; }));

    render(
      <PresetsManager canManage demo={false} readOnlyReason="Only admins can manage team presets." />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'View history for support-bot' }));
    expect(await screen.findByText('Version 2 snapshot')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View version 1' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    fireEvent.click(screen.getByRole('button', { name: 'View version 2' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));

    resolveV2?.(jsonResponse({ version: versions[0] }));
    expect(await screen.findByText('Version 2 snapshot')).toBeTruthy();
    resolveV1?.(jsonResponse({ version: versions[1] }));

    await waitFor(() => expect(screen.getByText('Version 2 snapshot')).toBeTruthy());
    expect(screen.queryByText('Version 1 snapshot')).toBeNull();
  });

  it('keeps demo mode visibly read-only and never exposes a write request path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      presets: [{
        slug: 'support-bot',
        version: 1,
        model: 'gpt-5.4',
        params: {},
        system_prompt: null,
        provider_prefs: null,
        enabled: true,
        updated_at: '2026-07-10T00:00:00.000Z',
      }],
    }));

    render(
      <PresetsManager
        canManage={false}
        demo
        readOnlyReason="Demo mode is read-only. Turn off sample data to change live workspace settings."
      />,
    );

    await screen.findByText('support-bot');
    expect(screen.getByRole('status').textContent).toContain('Demo mode —');
    expect(screen.queryByRole('button', { name: 'Create preset' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit support-bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable support-bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete support-bot' })).toBeNull();
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET']);
  });

  it('clears an open editor and reloads when a live dashboard switches into demo mode', async () => {
    const livePreset = {
      slug: 'support-bot',
      version: 1,
      model: 'gpt-5.4',
      params: {},
      system_prompt: null,
      provider_prefs: null,
      enabled: true,
      updated_at: '2026-07-10T00:00:00.000Z',
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ presets: [livePreset] }))
      .mockResolvedValueOnce(jsonResponse({ presets: [] }));

    const view = render(
      <PresetsManager
        canManage
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    await screen.findByText('support-bot');
    fireEvent.click(screen.getByRole('button', { name: 'Edit support-bot' }));
    expect(screen.getByRole('form', { name: 'Edit preset form' })).toBeTruthy();

    view.rerender(
      <PresetsManager
        canManage={false}
        demo
        readOnlyReason="Demo mode is read-only."
      />,
    );

    expect(screen.queryByRole('form', { name: 'Edit preset form' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create preset' })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('No presets yet')).toBeTruthy();
    expect(fetchMock.mock.calls.map((call) => (call[1] as RequestInit | undefined)?.method ?? 'GET')).toEqual(['GET', 'GET']);
  });

  it('hides write controls for non-admin members while retaining visible read-only access', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      presets: [{
        slug: 'support-bot',
        version: 1,
        model: 'gpt-5.4',
        params: {},
        system_prompt: null,
        provider_prefs: null,
        enabled: true,
        updated_at: '2026-07-10T00:00:00.000Z',
      }],
    }));

    render(
      <PresetsManager
        canManage={false}
        demo={false}
        readOnlyReason="Only admins can create, edit, disable, or delete team presets."
      />,
    );

    await screen.findByText('support-bot');
    expect(screen.getByRole('status').textContent).toContain('Only admins can create, edit, disable, or delete team presets.');
    expect(screen.getByRole('button', { name: 'View history for support-bot' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create preset' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit support-bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disable support-bot' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete support-bot' })).toBeNull();
  });

  it('shows a list error instead of a false empty state and retries the API request', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'presets_temporarily_unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ presets: [] }));

    render(
      <PresetsManager
        canManage={false}
        demo={false}
        readOnlyReason="Only admins can manage team presets."
      />,
    );

    expect((await screen.findByRole('alert')).textContent).toContain('presets_temporarily_unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No presets yet')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
