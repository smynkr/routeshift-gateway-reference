// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OverviewQuickStart } from '@/components/overview/overview-quick-start';

const DISMISS_KEY = 'routeshift.quick-start.dismissed.v1:team_1';

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key) => entries.delete(key),
    setItem: (key, value) => entries.set(key, String(value)),
  };
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('OverviewQuickStart', () => {
  it('derives first-run state from lifetime traffic and scopes demo dismissal to the effective workspace', () => {
    const overviewPage = readFileSync(join(__dirname, '../app/(dashboard)/overview/page.tsx'), 'utf8');

    expect(overviewPage).toContain(
      'SELECT EXISTS(SELECT 1 FROM request_logs WHERE team_id = $1) AS has_traffic',
    );
    expect(overviewPage).toContain('workspace_id: teamId');
    expect(overviewPage).toContain('!data.setup.has_traffic');
  });

  it('opens once for an empty live workspace and exposes an accessible three-step setup', async () => {
    render(
      <OverviewQuickStart
        autoOpen
        billingMode="subscription"
        hasApiKey={false}
        hasModelAccess={false}
        canManage
        workspaceId="team_1"
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Set up RouteShift' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByText('Three steps to your first routed request.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create an API key' }).getAttribute('href')).toBe('/keys');
    expect(screen.getByRole('link', { name: 'Connect a provider' }).getAttribute('href')).toBe('/settings');
    expect(screen.getByText('Send your first request')).toBeTruthy();

    const closeButton = screen.getByRole('button', { name: 'Close quick start' });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open quick start' })));
  });

  it('persists dismissal, stays closed on remount, and remains manually reopenable', async () => {
    const first = render(
      <OverviewQuickStart
        autoOpen
        billingMode="subscription"
        hasApiKey={false}
        hasModelAccess={false}
        canManage
        workspaceId="team_1"
      />,
    );

    await screen.findByRole('dialog', { name: 'Set up RouteShift' });
    fireEvent.click(screen.getByRole('button', { name: 'I’ll do this later' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe('1');

    first.unmount();
    const second = render(
      <OverviewQuickStart
        autoOpen
        billingMode="subscription"
        hasApiKey={false}
        hasModelAccess={false}
        canManage
        workspaceId="team_1"
      />,
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Open quick start' }));
    expect(await screen.findByRole('dialog', { name: 'Set up RouteShift' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'I’ll do this later' }));
    second.unmount();
    render(
      <OverviewQuickStart
        autoOpen
        billingMode="subscription"
        hasApiKey={false}
        hasModelAccess={false}
        canManage
        workspaceId="team_2"
      />,
    );
    expect(await screen.findByRole('dialog', { name: 'Set up RouteShift' })).toBeTruthy();
  });

  it('re-evaluates dismissal when the active workspace changes without a remount', async () => {
    window.localStorage.setItem('routeshift.quick-start.dismissed.v1:team_2', '1');
    const { rerender } = render(
      <OverviewQuickStart
        autoOpen
        billingMode="subscription"
        hasApiKey={false}
        hasModelAccess={false}
        canManage
        workspaceId="team_1"
      />,
    );

    expect(await screen.findByRole('dialog', { name: 'Set up RouteShift' })).toBeTruthy();

    rerender(
      <OverviewQuickStart
        autoOpen
        billingMode="subscription"
        hasApiKey={false}
        hasModelAccess={false}
        canManage
        workspaceId="team_2"
      />,
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows real setup progress and credits guidance for a funded credits workspace', async () => {
    render(
      <OverviewQuickStart
        autoOpen
        billingMode="credits"
        hasApiKey
        hasModelAccess
        canManage
        workspaceId="team_1"
      />,
    );

    await screen.findByRole('dialog', { name: 'Set up RouteShift' });
    expect(screen.getByText('API key ready')).toBeTruthy();
    expect(screen.getByText('Credits ready')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage credits' }).getAttribute('href')).toBe('/billing');
  });

  it('does not auto-open when the server suppresses first-run onboarding', async () => {
    render(
      <OverviewQuickStart
        autoOpen={false}
        billingMode="subscription"
        hasApiKey={false}
        hasModelAccess={false}
        canManage={false}
        workspaceId="team_1"
      />,
    );

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open quick start' })).toBeTruthy();
  });
});
