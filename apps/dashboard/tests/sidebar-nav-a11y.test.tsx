// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DASHBOARD_NAV_GROUPS, SidebarNav } from '@/components/sidebar-nav';

let pathname = '/overview';

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

vi.mock('@/components/demo-toggle', () => ({
  DemoToggle: () => null,
}));

beforeEach(() => {
  pathname = '/overview';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ billing_mode: 'subscription' }),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SidebarNav grouping and current-page semantics', () => {
  it('groups every destination exactly once by operator job', () => {
    render(<SidebarNav />);

    const dashboardNav = screen.getByRole('navigation', { name: 'Dashboard' });
    expect(dashboardNav).toBeDefined();
    for (const label of ['Observe', 'Route', 'Control', 'Workspace']) {
      expect(screen.getByText(label)).toBeDefined();
      expect(screen.getByRole('group', { name: label })).toBeDefined();
    }

    const hrefs = DASHBOARD_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));
    expect(hrefs).toHaveLength(16);
    expect(new Set(hrefs).size).toBe(16);
    expect(hrefs).toEqual(expect.arrayContaining([
      '/overview', '/activity', '/analytics', '/savings', '/usage', '/tokens', '/yield',
      '/routing', '/presets', '/shadow-experiments', '/models', '/keys', '/billing', '/plugins', '/settings', '/optimize',
    ]));
  });

  it('uses unique labelled group IDs for multiple sidebar instances', () => {
    render(
      <>
        <SidebarNav />
        <SidebarNav />
      </>,
    );

    const groups = screen.getAllByRole('group');
    const headingIds = groups.map((group) => group.getAttribute('aria-labelledby'));
    expect(new Set(headingIds).size).toBe(headingIds.length);

    for (const group of groups) {
      const headingId = group.getAttribute('aria-labelledby');
      expect(headingId).not.toBeNull();
      const heading = document.getElementById(headingId as string);
      expect(heading).not.toBeNull();
      expect(group.contains(heading)).toBe(true);
    }
  });

  it('marks only the active destination as the current page', () => {
    render(<SidebarNav />);

    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Routing Rules' }).getAttribute('aria-current')).toBeNull();
  });

  it('marks a parent destination current on nested routes', () => {
    pathname = '/routing/rules/new';
    render(<SidebarNav />);

    expect(screen.getByRole('link', { name: 'Routing Rules' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull();
  });
});
