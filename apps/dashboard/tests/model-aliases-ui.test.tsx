// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  EFFECTIVE_PUBLIC_MODELS,
} from '@routeshift/shared';
import { ModelAliasesSection } from '@/components/settings/model-aliases-section';

const fetchMock = vi.fn();
const chatModels = EFFECTIVE_DISPATCHABLE_CHAT_MODELS;
const embeddingModels = EFFECTIVE_PUBLIC_MODELS.filter((model) => (
  'kind' in model && model.kind === 'embedding'
));
const generatedChat = chatModels.find((model) => (
  'source' in model && model.source === 'generated'
));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModelAliasesSection effective target options', () => {
  it('offers every dispatchable chat target and round-trips a generated selection', async () => {
    expect(generatedChat).toBeDefined();
    if (!generatedChat) return;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ aliases: [] }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        alias: 'generated-target',
        canonical_name: generatedChat.canonical_name,
        proxy_cache_invalidated: true,
      }))
      .mockResolvedValueOnce(jsonResponse({
        aliases: [{
          alias: 'generated-target',
          canonical_name: generatedChat.canonical_name,
          notes: null,
          updated_at: '2026-08-27T00:00:00.000Z',
        }],
      }));

    render(<ModelAliasesSection />);
    await screen.findByText(/No aliases configured/);

    const target = screen.getByRole('combobox', { name: 'Canonical model' });
    const optionValues = within(target).getAllByRole('option').map((option) => (
      option as HTMLOptionElement
    ).value);
    expect(new Set(optionValues)).toEqual(new Set(chatModels.map((model) => model.canonical_name)));
    for (const embedding of embeddingModels) expect(optionValues).not.toContain(embedding.canonical_name);

    fireEvent.change(screen.getByRole('textbox', { name: 'Alias' }), {
      target: { value: 'generated-target' },
    });
    fireEvent.change(target, { target: { value: generatedChat.canonical_name } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      alias: 'generated-target',
      canonical_name: generatedChat.canonical_name,
    });
    expect(await screen.findByText('generated-target')).toBeTruthy();
  });
});
