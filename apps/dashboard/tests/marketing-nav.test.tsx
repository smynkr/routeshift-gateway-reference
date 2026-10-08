// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MarketingNav } from '@/components/marketing/marketing-nav';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

afterEach(() => cleanup());

describe('MarketingNav', () => {
  it('exposes the shared public destinations through a server-compatible mobile disclosure', () => {
    render(<MarketingNav />);

    const menuLabel = screen.getByText('Open menu');
    expect(menuLabel.closest('summary')).not.toBeNull();
    for (const label of ['Product', 'Models', 'Rankings', 'Pricing', 'Changelog', 'Docs', 'Login', 'Create free account']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
    expect(screen.queryAllByRole('link', { name: 'vs OpenRouter' })).toHaveLength(0);
  });

  it('uses the approved public destinations and isolates external Docs navigation', () => {
    render(<MarketingNav />);

    const expectedLinks = {
      Product: '/#product',
      Models: '/models',
      Rankings: '/rankings',
      Pricing: '/#pricing',
      Changelog: '/changelog',
      Docs: 'https://github.com/smynkr/routeshift-gateway-reference#readme',
    };
    for (const [label, href] of Object.entries(expectedLinks)) {
      expect(screen.getAllByRole('link', { name: label }).some((link) => link.getAttribute('href') === href)).toBe(true);
    }

    const docsLinks = screen.getAllByRole('link', { name: 'Docs' });
    for (const link of docsLinks) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('keeps account controls at least 44px tall with responsive visible labels', () => {
    render(<MarketingNav />);

    const accountLinks = screen.getAllByRole('link', { name: 'Create free account' });
    expect(accountLinks.length).toBeGreaterThan(0);
    for (const link of accountLinks) {
      expect(link.className).toContain('min-h-11');
    }
    expect(screen.getByText('Sign up')).toBeDefined();
    expect(screen.getAllByText('Create free account').length).toBeGreaterThan(0);
  });

  it('keeps the mobile disclosure within reach at a 200 percent zoom width', () => {
    render(<MarketingNav />);

    const menuPanel = screen.getByText('Open menu').closest('details')?.querySelector('div.absolute');
    expect(menuPanel?.className).toContain('w-[calc(100vw-2rem)]');
    expect(menuPanel?.className).toContain('max-w-64');
  });
});
