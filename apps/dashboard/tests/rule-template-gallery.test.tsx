// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { RuleTemplateGallery } from '@/components/routing/rule-template-gallery';

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

afterEach(() => cleanup());

describe('RuleTemplateGallery', () => {
  it('links only available templates to the publishable editor', () => {
    render(<RuleTemplateGallery />);

    const useLinks = screen.getAllByRole('link', { name: 'Use template' });
    expect(useLinks).toHaveLength(2);
    expect(useLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/routing/new?template=cheapest-internal-tools',
      '/routing/new?template=latency-first-ux',
    ]);
    expect(screen.getByText('Requires approved endpoint evidence.')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Why unavailable' })).toBeDefined();
  });

  it('does not offer editor links to read-only users', () => {
    render(<RuleTemplateGallery canManage={false} />);

    expect(screen.queryByRole('link', { name: 'Use template' })).toBeNull();
    expect(screen.getAllByText('Admin access required')).toHaveLength(2);
  });
});
