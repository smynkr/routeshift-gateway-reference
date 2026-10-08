// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { OverviewChecklist } from '@/components/overview/overview-checklist';

afterEach(() => {
  cleanup();
});

describe('overview first-request checklist', () => {
  it('marks completed steps done and links the remaining ones for managers', () => {
    render(<OverviewChecklist hasApiKey hasModelAccess={false} hasTraffic={false} canManage />);

    expect(screen.getAllByText('Done')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Open billing' }).getAttribute('href')).toBe('/billing');
    expect(screen.getByRole('link', { name: 'Open routing rules' }).getAttribute('href')).toBe('/routing');
    expect(screen.queryByRole('link', { name: 'Open API keys' })).toBeNull();
  });

  it('shows every step with its manage CTA on a fresh workspace', () => {
    render(<OverviewChecklist hasApiKey={false} hasModelAccess={false} hasTraffic={false} canManage />);

    for (const title of [
      'Create a scoped API key',
      'Connect provider access or credits',
      'Send the first request',
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: 'Open API keys' }).getAttribute('href')).toBe('/keys');
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('renders CTA hints without links for read-only roles', () => {
    render(<OverviewChecklist hasApiKey={false} hasModelAccess={false} hasTraffic={false} canManage={false} />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Open API keys')).toBeTruthy();
    expect(screen.getByText('Open billing')).toBeTruthy();
  });
});
