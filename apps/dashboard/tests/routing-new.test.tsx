// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import NewRulePage from '@/app/(dashboard)/routing/new/new-rule-client';
import { CURRENT_MODELS, requireCurrentModel } from '@/lib/current-models';
const h = vi.hoisted(() => ({
  searchParams: { get: vi.fn() },
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => h.searchParams,
  useRouter: () => ({ push: h.push }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('lucide-react', () => ({ ArrowLeft: () => <span aria-hidden="true" /> }));
vi.mock('@/components/models/model-autocomplete', () => ({
  ModelAutocomplete: ({ id, value, onChange, placeholder }: { id?: string; value: string; onChange: (value: string) => void; placeholder?: string }) => (
    <input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
  ),
}));
vi.mock('@/components/routing/quality-gate-editor', () => ({
  QualityGateEditor: () => null,
  buildQualityGateConfig: () => ({ ok: true, config: {} }),
  defaultQualityGateDraft: {},
}));

beforeEach(() => {
  h.searchParams.get.mockImplementation((key: string) => key === 'template' ? 'cheapest-internal-tools' : null);
  h.push.mockReset();
});
afterEach(() => cleanup());

describe('new routing rule template hydration', () => {
  it('hydrates the existing editor without submitting the draft', () => {
    render(<NewRulePage />);

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Cheapest internal tools');
    expect((screen.getByLabelText('Priority') as HTMLInputElement).value).toBe('500');
    expect((screen.getByLabelText('Target Provider') as HTMLSelectElement).value).toBe(requireCurrentModel('economy').provider);
    expect((screen.getByLabelText('Target Model (optional)') as HTMLInputElement).value).toBe(CURRENT_MODELS.economy);
    expect((screen.getByLabelText('Request Tags') as HTMLInputElement).value).toBe('internal');
    expect((screen.getByPlaceholderText('Fallback model') as HTMLInputElement).value).toBe(CURRENT_MODELS.coding);
    expect(screen.getByRole('button', { name: 'Create Rule' })).toBeDefined();
  });

  it('rejects an unavailable template before publish', () => {
    h.searchParams.get.mockImplementation((key: string) => key === 'template' ? 'eu-only-data' : null);
    render(<NewRulePage />);

    expect(screen.getByText('This routing rule template is unavailable until endpoint evidence is approved.')).toBeDefined();
  });
});
