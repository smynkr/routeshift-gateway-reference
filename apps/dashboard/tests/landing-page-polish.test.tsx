// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LandingPage from '../app/page';
import { LandingContent } from '@/components/marketing/landing-content';
import { LiveCatalogBadge } from '@/components/marketing/live-catalog-badge';
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));


afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('landing page proof-first contract', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('catalog unavailable')));
  });


  it('upgrades the durable compatibility label when the live catalog responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: vi.fn().mockResolvedValue({ modelCount: 95, providerCount: 9 }),
      }),
    );
    render(<LandingContent />);

    expect(screen.getByText('Compatibility from the shipped catalog')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByText('Live catalog · 95 models · 9 providers')).toBeDefined();
    });
  });

  it('retains the durable compatibility label after a controlled rejected catalog request', async () => {
    let rejectFetch!: (reason?: unknown) => void;
    const pendingFetch = new Promise<unknown>((_resolve, reject) => {
      rejectFetch = reject;
    });

    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pendingFetch));
    render(<LandingContent />);

    expect(screen.getByText('Compatibility from the shipped catalog')).toBeDefined();
    await act(async () => {
      rejectFetch(new Error('offline'));
      await pendingFetch.catch(() => undefined);
      await Promise.resolve();
    });
    expect(screen.queryByText('Live catalog unavailable')).toBeNull();
    expect(screen.getByText('Compatibility from the shipped catalog')).toBeDefined();
  });
  it('aborts the live catalog request on unmount without painting a stale badge', async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return promise;
    }));

    const { unmount } = render(<LiveCatalogBadge label="Compatibility from the shipped catalog" />);
    expect(signal).toBeDefined();
    unmount();
    expect(signal?.aborted).toBe(true);

    resolve(new Response(JSON.stringify({ modelCount: 95, providerCount: 9 }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText(/Live catalog/)).toBeNull();
  });

  it('keeps the durable catalog label when a 200 response is HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: vi.fn().mockResolvedValue({ modelCount: 95, providerCount: 9 }),
    }));
    render(<LiveCatalogBadge label="Compatibility from the shipped catalog" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Compatibility from the shipped catalog')).toBeDefined();
    expect(screen.queryByText('Live catalog · 95 models · 9 providers')).toBeNull();
  });


  it('renders a tabbed quickstart with real integration paths', () => {
    render(<LandingPage />);

    // The cURL tab is selected by default.
    expect(screen.getByRole('tab', { name: 'cURL' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('tab', { name: 'TypeScript SDK' }));
    expect(screen.getByRole('tabpanel').textContent).toContain('new ProxyClient');

    fireEvent.click(screen.getByRole('tab', { name: 'Agent CLI' }));
    expect(screen.getByRole('tab', { name: 'Agent CLI' }).getAttribute('aria-selected')).toBe('true');
  });

  it('drives the cURL quickstart from registry-backed model ids', () => {
    render(<LandingPage />);

    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement;
    const options = [...modelSelect.options].map((option) => option.value);
    expect(options.length).toBeGreaterThan(8);
    expect(options).toContain('gpt-5.4');
    expect(options).not.toContain('llama-4-maverick');

    fireEvent.change(modelSelect, { target: { value: 'claude-sonnet-5' } });
    expect(screen.getByRole('tabpanel').textContent).toContain('"model": "claude-sonnet-5"');
  });

  it('pairs the SDK quickstart model with a cross-provider fallback', () => {
    render(<LandingPage />);

    // Default: selected gpt-5.4 primary, Anthropic fallback (canonical public id).
    fireEvent.click(screen.getByRole('tab', { name: 'TypeScript SDK' }));
    expect(screen.getByRole('tabpanel').textContent).toContain(
      "models: ['gpt-5.4', 'claude-opus-4-6']",
    );

    // Anthropic primary flips the fallback to OpenAI (select lives on the cURL tab).
    fireEvent.click(screen.getByRole('tab', { name: 'cURL' }));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'claude-sonnet-5' } });
    fireEvent.click(screen.getByRole('tab', { name: 'TypeScript SDK' }));
    expect(screen.getByRole('tabpanel').textContent).toContain(
      "models: ['claude-sonnet-5', 'gpt-5.4']",
    );
  });

  it('copies the visible snippet to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      render(<LandingPage />);
      const visibleSnippet = screen.getByRole('tabpanel').textContent;
      fireEvent.click(screen.getByRole('button', { name: 'Copy snippet to clipboard' }));
      expect(writeText).toHaveBeenCalledWith(visibleSnippet);
      expect(await screen.findByText('Copied')).toBeDefined();
    } finally {
      // jsdom has no clipboard by default; remove the mock so other tests see the pristine navigator.
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    }
  });

  it('selects the snippet when the clipboard API is unavailable', () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<LandingPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy snippet to clipboard' }));
    expect(window.getSelection()?.toString()).toBeTruthy();
  });
});
