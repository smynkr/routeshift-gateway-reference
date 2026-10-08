// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpendAnomalySettings } from '@/components/billing/spend-anomaly-settings';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({
    enabled: false,
    webhook_url: 'https://alerts.example.test/routeshift',
    threshold_multiplier: 2,
    baseline_days: 7,
  }), { status: 200 }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SpendAnomalySettings', () => {
  it('loads settings without exposing a signing secret', async () => {
    render(<SpendAnomalySettings />);

    await waitFor(() => expect((screen.getByLabelText('Webhook URL') as HTMLInputElement).value)
      .toBe('https://alerts.example.test/routeshift'));
    expect(screen.queryByText(/signing secret/i)).toBeNull();
    expect(screen.queryByLabelText(/secret/i)).toBeNull();
  });

  it('saves validated settings and shows confirmation', async () => {
    render(<SpendAnomalySettings />);
    await waitFor(() => expect(screen.getByLabelText('Webhook URL')).toBeDefined());

    fireEvent.change(screen.getByLabelText('Threshold multiplier'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Baseline days'), { target: { value: '14' } });
    fireEvent.click(screen.getByLabelText('Enabled'));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      enabled: true,
      webhook_url: 'https://alerts.example.test/routeshift',
      threshold_multiplier: 3,
      baseline_days: 14,
    }), { status: 200 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save spend alerts' }));

    await waitFor(() => expect(screen.getByText('Spend alert settings saved.')).toBeDefined());
    expect(fetchMock).toHaveBeenLastCalledWith('/api/alerts/spend', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        enabled: true,
        webhook_url: 'https://alerts.example.test/routeshift',
        threshold_multiplier: 3,
        baseline_days: 14,
      }),
    }));
  });

  it('blocks editing and offers retry when the initial settings load fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary failure' }), { status: 503 }));
    render(<SpendAnomalySettings />);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('temporary failure'));
    expect(screen.queryByRole('button', { name: 'Save spend alerts' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect((screen.getByLabelText('Webhook URL') as HTMLInputElement).value)
      .toBe('https://alerts.example.test/routeshift'));
  });
});
