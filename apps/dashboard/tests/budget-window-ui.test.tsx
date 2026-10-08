// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MonthlyBudgetSettings } from '@/components/billing/monthly-budget-settings';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));

beforeEach(() => {
  h.fetch.mockReset();
});

afterEach(() => {
  cleanup();
});

const baseState = {
  windows: [
    { kind: 'daily', cap_usd: 10, known_spend_usd: 4, reserved_usd: 0, unknown_held_usd: 0, committed_usd: 4, unknown_cost_requests: 0, status: 'ok', action: 'block', period_start: '2026-08-09T00:00:00.000Z', period_end: '2026-08-10T00:00:00.000Z', reset_at: '2026-08-10T00:00:00.000Z' },
    { kind: 'weekly', cap_usd: 50, known_spend_usd: 12, reserved_usd: 0, unknown_held_usd: 3, committed_usd: 15, unknown_cost_requests: 1, status: 'alert', action: 'block', period_start: '2026-08-03T00:00:00.000Z', period_end: '2026-08-10T00:00:00.000Z', reset_at: '2026-08-10T00:00:00.000Z' },
    { kind: 'monthly', cap_usd: null, known_spend_usd: 0, reserved_usd: 0, unknown_held_usd: 0, committed_usd: 0, unknown_cost_requests: 0, status: 'ok', action: null, period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-09-01T00:00:00.000Z', reset_at: '2026-09-01T00:00:00.000Z' },
  ],
  actual_costs_qualified: false,
  alert_at_pct: 80,
  hard_cap_action: 'block',
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('MonthlyBudgetSettings three-window UI (RSH-138)', () => {
  it('renders labeled daily, weekly, and monthly controls', async () => {
    vi.stubGlobal('fetch', h.fetch.mockResolvedValue(jsonResponse(baseState)));
    render(<MonthlyBudgetSettings />);

    expect(await screen.findByText('Budget windows')).toBeTruthy();
    expect(screen.getByLabelText('Daily cap (USD)')).toBeTruthy();
    expect(screen.getByLabelText('Weekly cap (USD)')).toBeTruthy();
    expect(screen.getByLabelText('Monthly cap (USD)')).toBeTruthy();
  });

  it('shows a visible lower-bound notice when unknown spend is held', async () => {
    vi.stubGlobal('fetch', h.fetch.mockResolvedValue(jsonResponse(baseState)));
    render(<MonthlyBudgetSettings />);

    await screen.findByText('Budget windows');
    await waitFor(() => {
      expect(screen.getAllByText(/observed lower bound/).length).toBeGreaterThan(0);
    });
    // Weekly window holds $3 unknown
    expect(screen.getByText(/\$3\.00 held unresolved/)).toBeTruthy();
  });

  it('initializes cap inputs from the loaded state', async () => {
    vi.stubGlobal('fetch', h.fetch.mockResolvedValue(jsonResponse(baseState)));
    render(<MonthlyBudgetSettings />);

    await waitFor(() => {
      expect((screen.getByLabelText('Daily cap (USD)') as HTMLInputElement).value).toBe('10');
      expect((screen.getByLabelText('Weekly cap (USD)') as HTMLInputElement).value).toBe('50');
      expect((screen.getByLabelText('Monthly cap (USD)') as HTMLInputElement).value).toBe('');
    });
  });

  it('sends an explicit null for a blank cap input (clears that window only)', async () => {
    h.fetch
      .mockResolvedValueOnce(jsonResponse(baseState))
      .mockResolvedValueOnce(jsonResponse({ ...baseState, windows: baseState.windows.map((w) => (w.kind === 'daily' ? { ...w, cap_usd: null } : w)) }));
    vi.stubGlobal('fetch', h.fetch);
    render(<MonthlyBudgetSettings canEdit />);

    const dailyInput = (await screen.findByLabelText('Daily cap (USD)')) as HTMLInputElement;
    // clear the input → explicit null on save
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(dailyInput, '');
    dailyInput.dispatchEvent(new Event('input', { bubbles: true }));
    screen.getByText('Save budget windows').click();

    await waitFor(() => {
      const putCall = h.fetch.mock.calls.find(
        ([url, init]) => url === '/api/billing/budget' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(((putCall![1] as RequestInit).body as string));
      expect(body.daily_usd_cap).toBeNull();
      expect(body.weekly_usd_cap).toBe(50);
      expect(body.monthly_usd_cap).toBeNull();
    });
  });

  it('blocks saving without edit permission', async () => {
    vi.stubGlobal('fetch', h.fetch.mockResolvedValue(jsonResponse(baseState)));
    render(<MonthlyBudgetSettings canEdit={false} />);

    await screen.findByText('Budget windows');
    screen.getByText('Save budget windows').click();

    await waitFor(() => {
      // No PUT may be issued; the read-only reason is surfaced.
      const puts = h.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
      expect(puts).toHaveLength(0);
      expect(screen.getByText(/Only admins can manage budgets/)).toBeTruthy();
    });
  });
});
