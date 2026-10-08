// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EFFECTIVE_DISPATCHABLE_CHAT_MODELS,
  EFFECTIVE_PUBLIC_MODELS,
} from '@routeshift/shared';
import { CreateKeyDialog } from '@/components/keys/create-key-dialog';
import { EditKeyDialog } from '@/components/keys/edit-key-dialog';

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: h.refresh }),
}));

const generatedChat = EFFECTIVE_DISPATCHABLE_CHAT_MODELS.find((model) => (
  'source' in model && model.source === 'generated'
));
const embedding = EFFECTIVE_PUBLIC_MODELS.find((model) => (
  'kind' in model && model.kind === 'embedding'
));

beforeEach(() => {
  h.fetch.mockReset();
  h.refresh.mockReset();
  vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('API key effective model scopes', () => {
  it('creates a key scoped to generated chat and embedding catalog rows', async () => {
    expect(generatedChat).toBeDefined();
    expect(embedding).toBeDefined();
    if (!generatedChat || !embedding) return;
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ key: 'rs_live_created' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));

    render(<CreateKeyDialog />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Key' }));
    fireEvent.click(screen.getByRole('button', { name: /show advanced options/i }));
    const scopeOptions = screen.getAllByRole('checkbox').map((checkbox) => (
      checkbox.closest('label')?.textContent?.trim()
    )).filter((value): value is string => Boolean(value));
    expect(new Set(scopeOptions)).toEqual(new Set(
      EFFECTIVE_PUBLIC_MODELS.map((model) => model.canonical_name),
    ));
    fireEvent.click(screen.getByLabelText(generatedChat.canonical_name));
    fireEvent.click(screen.getByLabelText(embedding.canonical_name));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).allowed_models).toEqual([
      generatedChat.canonical_name,
      embedding.canonical_name,
    ]);
  });

  it('keeps existing generated scopes visible so they can be preserved or removed', async () => {
    expect(generatedChat).toBeDefined();
    if (!generatedChat) return;
    const retiredGeneratedScope = 'generated-scope-retained-from-prior-catalog';
    h.fetch.mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    render(<EditKeyDialog keyRow={{
      id: 'key_1',
      name: 'Production',
      allowed_models: [generatedChat.canonical_name, retiredGeneratedScope],
      expires_at: null,
      rate_limit_override: null,
      metadata: {},
    }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect((screen.getByLabelText(generatedChat.canonical_name) as HTMLInputElement).checked).toBe(true);
    const retiredCheckbox = screen.getByLabelText(retiredGeneratedScope) as HTMLInputElement;
    expect(retiredCheckbox.checked).toBe(true);
    fireEvent.click(retiredCheckbox);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [, init] = h.fetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).allowed_models).toEqual([generatedChat.canonical_name]);
  });
});
