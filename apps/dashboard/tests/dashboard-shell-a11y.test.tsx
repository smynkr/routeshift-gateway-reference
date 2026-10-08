// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DashboardShell } from '@/components/dashboard-shell';

vi.mock('@/components/sidebar-nav', () => ({
  SidebarNav: () => <a href="/overview">Overview</a>,
}));

vi.mock('@/components/demo-provenance-banner', () => ({
  DemoProvenanceBanner: () => null,
}));

let offsetParentDescriptor: PropertyDescriptor | undefined;
let desktopMediaQuery: {
  matches: boolean;
  listeners: Set<() => void>;
};

beforeEach(() => {
  desktopMediaQuery = {
    matches: false,
    listeners: new Set(),
  };
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
    get matches() {
      return desktopMediaQuery.matches;
    },
    addEventListener: (_event: string, listener: () => void) => desktopMediaQuery.listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => desktopMediaQuery.listeners.delete(listener),
  })));
  offsetParentDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = '';
  if (offsetParentDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParentDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent');
  }
});

describe('DashboardShell mobile navigation', () => {
  it('opens as a labelled modal dialog, traps focus, and locks background scroll', async () => {
    render(<DashboardShell><p>Dashboard content</p></DashboardShell>);

    const openButton = screen.getByRole('button', { name: 'Open dashboard navigation' });
    fireEvent.click(openButton);

    const dialog = screen.getByRole('dialog', { name: 'Dashboard navigation' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');

    const closeButton = screen.getByRole('button', { name: 'Close dashboard navigation' });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));

    const overviewLink = screen.getAllByRole('link', { name: 'Overview' })[1];
    overviewLink.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(dialog.querySelector('a'));
  });

  it('closes on Escape, restores trigger focus, and releases scroll lock', async () => {
    render(<DashboardShell><p>Dashboard content</p></DashboardShell>);

    const openButton = screen.getByRole('button', { name: 'Open dashboard navigation' });
    fireEvent.click(openButton);
    await screen.findByRole('dialog', { name: 'Dashboard navigation' });

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Dashboard navigation' })).toBeNull());
    expect(document.activeElement).toBe(openButton);
    expect(document.body.style.overflow).toBe('');
  });

  it('closes and releases scroll lock when the viewport crosses the desktop breakpoint', async () => {
    render(<DashboardShell><p>Dashboard content</p></DashboardShell>);

    fireEvent.click(screen.getByRole('button', { name: 'Open dashboard navigation' }));
    await screen.findByRole('dialog', { name: 'Dashboard navigation' });
    expect(document.body.style.overflow).toBe('hidden');

    desktopMediaQuery.matches = true;
    for (const listener of desktopMediaQuery.listeners) listener();

    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: 'Dashboard navigation' }),
    ).toBeNull());
    expect(document.body.style.overflow).toBe('');

    desktopMediaQuery.matches = false;
    for (const listener of desktopMediaQuery.listeners) listener();
    expect(screen.queryByRole('dialog', { name: 'Dashboard navigation' })).toBeNull();
  });
});
