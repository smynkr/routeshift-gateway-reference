// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SavingsPage from '@/app/(dashboard)/savings/page';

const h = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('@/lib/rbac', () => ({
  requireTeamMembership: vi.fn().mockResolvedValue({ teamId: 'team_1', userId: 'user_1', role: 'admin' }),
}));
vi.mock('@/lib/demo', () => ({ getEffectiveTeamId: vi.fn().mockResolvedValue('team_1') }));
vi.mock('@/lib/db', () => ({ getPool: () => ({ query: h.query }) }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <span data-next-link={href}>{children}</span>
  ),
}));
vi.mock('lucide-react', () => ({ Zap: () => <span aria-hidden="true" /> }));
vi.mock('@/components/stats/kpi-card', () => ({ KpiCard: () => <div /> }));
vi.mock('@/components/charts/savings-chart', () => ({ SavingsChart: () => <div /> }));
vi.mock('@/components/cost-qualification-notice', () => ({ CostQualificationNotice: () => <div /> }));

beforeEach(() => {
  h.query.mockReset()
    .mockResolvedValueOnce({ rows: [{ total_original_microcents: '0', total_actual_microcents: '0', total_billed_spend_microcents: '0', total_savings_microcents: '0', unknown_cost_requests: '0', total_requests: '0' }] })
    .mockResolvedValueOnce({ rows: [] });
});
afterEach(() => cleanup());

describe('SavingsPage receipt link', () => {
  it('links to the current UTC month receipt endpoint as a download', async () => {
    render(await SavingsPage());

    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const link = screen.getByRole('link', { name: 'Download monthly receipt' });
    expect(link.getAttribute('href')).toBe(`/api/metrics/savings-receipt?month=${month}`);
    expect(link.getAttribute('download')).not.toBeNull();
  });
});
