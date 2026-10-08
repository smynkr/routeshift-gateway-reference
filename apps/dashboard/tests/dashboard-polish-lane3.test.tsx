// @vitest-environment jsdom

import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AutoTopUpSettings } from '@/components/credits/auto-topup-settings';

function read(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('dashboard polish lane 3', () => {
  it('keeps Keys and Routing empty states permission-aware and stacks their headers on mobile', () => {
    const keys = read('app/(dashboard)/keys/page.tsx');
    const routing = read('app/(dashboard)/routing/page.tsx');

    expect(keys).toContain('flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between');
    expect(keys).toContain('Ask an admin to create one');
    expect(routing).toContain('flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between');
    expect(routing).toContain('Ask an admin to create one');
  });

  it('exposes enabled auto top-up as a clearly named disable action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        enabled: true,
        threshold_cents: 500,
        reload_amount_cents: 2500,
      }),
    }));

    render(<AutoTopUpSettings />);

    const toggle = await screen.findByRole('button', { name: 'Disable auto top-up' });
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('role')).toBeNull();
    expect(toggle.getAttribute('aria-checked')).toBeNull();
  });

  it('treats disabled auto top-up as a configuration disclosure, not a false switch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: async () => ({
        enabled: false,
        threshold_cents: 500,
        reload_amount_cents: 2500,
      }),
    }));

    render(<AutoTopUpSettings />);

    const configure = await screen.findByRole('button', { name: 'Configure auto top-up' });
    expect(configure.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(configure);

    expect(screen.getByRole('button', { name: 'Hide auto top-up settings' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/configured in draft mode/i)).toBeTruthy();
  });
});
