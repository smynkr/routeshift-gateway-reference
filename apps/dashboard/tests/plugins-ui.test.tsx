// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginsClient } from '@/app/(dashboard)/plugins/plugins-client';
import { formatMicrocentsAsUsd } from '@/lib/plugins';
import type { PluginsUsageEnvelope } from '@/lib/plugins';

afterEach(cleanup);

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

/** The route ALWAYS zero-fills every known PLUGIN_IDS row; override per test. */
function envelopeWith(overrides: Partial<PluginsUsageEnvelope> = {}): PluginsUsageEnvelope {
  return {
    period: '7d',
    summary: {
      total_plugin_cost_microcents: 0,
      total_runs: 0,
      requests_with_plugins: 0,
      by_plugin: [
        { plugin_id: 'web', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
        { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
      ],
    },
    recent_warnings: [],
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch as unknown as typeof fetch);
});

describe('PluginsClient explainer', () => {
  it('renders the explainer section headings regardless of usage state', () => {
    h.fetch.mockReturnValue(new Promise<Response>(() => {}));

    render(<PluginsClient demo={false} />);

    expect(screen.getByText('Plugins')).toBeTruthy();
    expect(screen.getByText('Activate plugins')).toBeTruthy();
    expect(screen.getByText('Web search')).toBeTruthy();
    expect(screen.getByText('File parser')).toBeTruthy();
    expect(screen.getByText('Failure contract')).toBeTruthy();
    expect(screen.getByText('Privacy')).toBeTruthy();
  });
});

describe('PluginsClient usage states', () => {
  it('shows the skeleton while the first fetch is in flight', () => {
    h.fetch.mockReturnValue(new Promise<Response>(() => {}));

    const { container } = render(<PluginsClient demo={false} />);

    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('shows the house error state with retry and re-fetches when retry is clicked', async () => {
    h.fetch
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse(200, envelopeWith()));

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Failed to load plugin usage.')).toBeTruthy();

    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
  });

  it('surfaces proxy error codes verbatim on non-ok responses', async () => {
    h.fetch.mockResolvedValue(jsonResponse(500, { error: { message: 'Boom', code: 'internal' } }));

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Boom')).toBeTruthy();
    expect(screen.getByText('internal')).toBeTruthy();
  });

  it('surfaces a flat-string proxy error verbatim (not the fallback)', async () => {
    h.fetch.mockResolvedValue(jsonResponse(500, { error: 'Failed to load plugin usage' }));

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getByText('Failed to load plugin usage')).toBeTruthy());
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('rejects an invalid envelope instead of rendering untrusted numbers', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { wrong: true }));

    render(<PluginsClient demo={false} />);

    await waitFor(() =>
      expect(screen.getByText('Received an invalid plugin usage response.')).toBeTruthy(),
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('rejects an envelope with a negative cost into the invalid-response state', async () => {
    h.fetch.mockResolvedValue(
      jsonResponse(200, envelopeWith({
        summary: {
          total_plugin_cost_microcents: -1,
          total_runs: 1,
          requests_with_plugins: 1,
          by_plugin: [
            { plugin_id: 'web', runs: 1, ok: 1, warning: 0, error: 0, skipped: 0, cost_microcents: 1 },
            { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
          ],
        },
      })),
    );

    render(<PluginsClient demo={false} />);

    await waitFor(() =>
      expect(screen.getByText('Received an invalid plugin usage response.')).toBeTruthy(),
    );
  });

  it('renders summary numbers with money formatted via formatMicrocentsAsUsd', async () => {
    expect(formatMicrocentsAsUsd(500_000)).toBe('$0.005');

    h.fetch.mockResolvedValue(
      jsonResponse(200, envelopeWith({
        summary: {
          total_plugin_cost_microcents: 500_000,
          total_runs: 49,
          requests_with_plugins: 3,
          by_plugin: [
            { plugin_id: 'web', runs: 42, ok: 40, warning: 1, error: 1, skipped: 0, cost_microcents: 500_000 },
            { plugin_id: 'file-parser', runs: 7, ok: 5, warning: 0, error: 0, skipped: 2, cost_microcents: 0 },
          ],
        },
      })),
    );

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getAllByText('$0.005').length).toBe(2));
    expect(screen.getByText('49')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('renders the per-plugin breakdown table with both plugin rows', async () => {
    h.fetch.mockResolvedValue(
      jsonResponse(200, envelopeWith({
        summary: {
          total_plugin_cost_microcents: 500_000,
          total_runs: 49,
          requests_with_plugins: 3,
          by_plugin: [
            { plugin_id: 'web', runs: 42, ok: 40, warning: 1, error: 1, skipped: 0, cost_microcents: 500_000 },
            { plugin_id: 'file-parser', runs: 7, ok: 5, warning: 0, error: 0, skipped: 2, cost_microcents: 0 },
          ],
        },
      })),
    );

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getAllByText('web').length).toBeGreaterThanOrEqual(1));
    expect(screen.getAllByText('file-parser').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('40')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('renders recent warnings with the detail code verbatim', async () => {
    h.fetch.mockResolvedValue(
      jsonResponse(200, envelopeWith({
        summary: {
          total_plugin_cost_microcents: 0,
          total_runs: 3,
          requests_with_plugins: 3,
          by_plugin: [
            { plugin_id: 'web', runs: 3, ok: 2, warning: 1, error: 0, skipped: 0, cost_microcents: 0 },
            { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
          ],
        },
        recent_warnings: [{
          plugin_id: 'web',
          status: 'warning',
          detail: 'web_search_backend_timeout',
          cost_microcents: 0,
          latency_ms: 5000,
          created_at: '2026-08-05T10:00:00Z',
        }],
      })),
    );

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getByText('web_search_backend_timeout')).toBeTruthy());
  });

  it('shows the honest empty state when the envelope is all zeros', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, envelopeWith()));

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getByText('No plugin usage')).toBeTruthy());
    expect(screen.queryByText('Total plugin cost')).toBeNull();
  });

  it('rejects an envelope whose period does not match the requested one', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, envelopeWith({ period: '24h' })));

    render(<PluginsClient demo={false} />);

    // Default request is 7d; an echo of a different (still whitelisted) period
    // means the answer does not describe the requested window.
    await waitFor(() =>
      expect(screen.getByText('Received an invalid plugin usage response.')).toBeTruthy(),
    );
  });

  it('surfaces a session-expired error (never a silent skeleton) when the 401 redirect cannot land', async () => {
    h.fetch.mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' }));

    render(<PluginsClient demo={false} />);

    // jsdom cannot navigate (location.href assignment is a no-op), so the
    // failure must degrade to a visible error state that explains the redirect.
    await waitFor(() =>
      expect(screen.getByText('Session expired — redirecting to login.')).toBeTruthy(),
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('keeps the period-scoped empty state reachable alongside all-time warnings', async () => {
    h.fetch.mockResolvedValue(
      jsonResponse(200, envelopeWith({
        recent_warnings: [{
          plugin_id: 'web',
          status: 'warning',
          detail: 'web_search_backend_timeout',
          cost_microcents: 0,
          latency_ms: 5000,
          created_at: '2026-01-08T10:00:00Z',
        }],
      })),
    );

    render(<PluginsClient demo={false} />);

    // The empty state is keyed on period-scoped runs ONLY; an ancient warning
    // must not suppress it, and the warnings feed must disclaim its scope.
    await waitFor(() => expect(screen.getByText('No plugin usage')).toBeTruthy());
    expect(screen.getByText('web_search_backend_timeout')).toBeTruthy();
    expect(screen.getByText(/all-time/)).toBeTruthy();
    expect(screen.queryByText('Total plugin cost')).toBeNull();
  });

  it('rejects a cross-field-inconsistent envelope (zero runs, positive cost)', async () => {
    h.fetch.mockResolvedValue(
      jsonResponse(200, envelopeWith({
        summary: {
          total_plugin_cost_microcents: 500_000,
          total_runs: 0,
          requests_with_plugins: 0,
          by_plugin: [
            { plugin_id: 'web', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
            { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
          ],
        },
      })),
    );

    render(<PluginsClient demo={false} />);

    await waitFor(() =>
      expect(screen.getByText('Received an invalid plugin usage response.')).toBeTruthy(),
    );
    expect(screen.queryByText('No plugin usage')).toBeNull();
  });

  it('rejects an envelope where requests-with-plugins exceeds total runs', async () => {
    h.fetch.mockResolvedValue(
      jsonResponse(200, envelopeWith({
        summary: {
          total_plugin_cost_microcents: 0,
          total_runs: 1,
          requests_with_plugins: 2,
          by_plugin: [
            { plugin_id: 'web', runs: 1, ok: 1, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
            { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
          ],
        },
      })),
    );

    render(<PluginsClient demo={false} />);

    await waitFor(() =>
      expect(screen.getByText('Received an invalid plugin usage response.')).toBeTruthy(),
    );
  });

  it('renders plugin ids the route unions from the table but the client does not know', async () => {
    h.fetch.mockResolvedValue(
      jsonResponse(200, envelopeWith({
        summary: {
          total_plugin_cost_microcents: 9_000_000,
          total_runs: 5,
          requests_with_plugins: 3,
          by_plugin: [
            { plugin_id: 'web', runs: 3, ok: 3, warning: 0, error: 0, skipped: 0, cost_microcents: 7_500_000 },
            { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
            { plugin_id: 'code-exec', runs: 2, ok: 1, warning: 0, error: 1, skipped: 0, cost_microcents: 1_500_000 },
          ],
        },
      })),
    );

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getByText('code-exec')).toBeTruthy());
  });

  it('discards a stale out-of-order response instead of clobbering the newer period', async () => {
    let resolveFirst!: (r: Response) => void;
    let resolveSecond!: (r: Response) => void;
    h.fetch
      .mockReturnValueOnce(new Promise<Response>((res) => { resolveFirst = res; }))
      .mockReturnValueOnce(new Promise<Response>((res) => { resolveSecond = res; }));

    render(<PluginsClient demo={false} />);
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Usage period'), { target: { value: '24h' } });
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));

    // Markers are unique numbers that appear exactly once each in ready markup
    // (KPI value, requests KPI, web-row runs) so a stale write is observable.
    const marked = (totalRuns: number, requests: number, webRuns: number, period: '7d' | '24h') => envelopeWith({
      period,
      summary: {
        total_plugin_cost_microcents: 0,
        total_runs: totalRuns,
        requests_with_plugins: requests,
        by_plugin: [
          { plugin_id: 'web', runs: webRuns, ok: webRuns - 1, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
          { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
        ],
      },
    });

    // The newer 24h request resolves first, then the STALE 7d response late.
    resolveSecond(jsonResponse(200, marked(64, 13, 21, '24h')));
    await waitFor(() => expect(screen.getByText('64')).toBeTruthy());

    resolveFirst(jsonResponse(200, marked(99, 42, 17, '7d')));
    await waitFor(() => {
      expect(screen.queryByText('99')).toBeNull();
      expect(screen.queryByText('42')).toBeNull();
      expect(screen.queryByText('17')).toBeNull();
      expect(screen.getByText('64')).toBeTruthy();
      expect(screen.getByText('13')).toBeTruthy();
      expect(screen.getByText('21')).toBeTruthy();
    });
  });

  it('marks the usage card busy without hiding data during a period-switch refetch', async () => {
    h.fetch.mockResolvedValueOnce(jsonResponse(200, envelopeWith({
      summary: {
        total_plugin_cost_microcents: 0,
        total_runs: 64,
        requests_with_plugins: 13,
        by_plugin: [
          { plugin_id: 'web', runs: 21, ok: 21, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
          { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
        ],
      },
    })));

    render(<PluginsClient demo={false} />);
    await waitFor(() => expect(screen.getByText('64')).toBeTruthy());
    expect(screen.getByLabelText('Plugin usage data').getAttribute('aria-busy')).toBe('false');

    h.fetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    fireEvent.change(screen.getByLabelText('Usage period'), { target: { value: '24h' } });

    await waitFor(() =>
      expect(screen.getByLabelText('Plugin usage data').getAttribute('aria-busy')).toBe('true'),
    );
    expect(screen.getByText('Updating…')).toBeTruthy();
    // Prior data stays on screen while the new period loads (no skeleton reset).
    expect(screen.getByText('64')).toBeTruthy();
  });

  it('keeps last-known-good numbers with an inline banner when a period-switch refetch fails', async () => {
    h.fetch.mockResolvedValueOnce(jsonResponse(200, envelopeWith({
      summary: {
        total_plugin_cost_microcents: 0,
        total_runs: 64,
        requests_with_plugins: 13,
        by_plugin: [
          { plugin_id: 'web', runs: 21, ok: 20, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
          { plugin_id: 'file-parser', runs: 0, ok: 0, warning: 0, error: 0, skipped: 0, cost_microcents: 0 },
        ],
      },
    })));

    render(<PluginsClient demo={false} />);
    await waitFor(() => expect(screen.getByText('64')).toBeTruthy());

    h.fetch.mockRejectedValueOnce(new Error('pool exhausted'));
    fireEvent.change(screen.getByLabelText('Usage period'), { target: { value: '24h' } });

    // Failure must not destroy the data already on screen — and the banner
    // must name the period of the numbers still visible, because the selector
    // already advanced to 24h.
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Failed to load plugin usage.')).toBeTruthy();
    expect(screen.getByText(/for Last 7 days/)).toBeTruthy();
    expect(screen.getByText('64')).toBeTruthy();
    expect(screen.getByText('21')).toBeTruthy();

    h.fetch.mockResolvedValueOnce(jsonResponse(200, envelopeWith({ period: '24h' })));
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    await waitFor(() => expect(screen.getByText('No plugin usage')).toBeTruthy());
  });

  it('refetches with the selected period', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, envelopeWith()));

    render(<PluginsClient demo={false} />);

    await waitFor(() => expect(screen.getByText('No plugin usage')).toBeTruthy());
    const [initialUrl] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(initialUrl).toBe('/api/plugins/usage?period=7d');

    fireEvent.change(screen.getByLabelText('Usage period'), { target: { value: '24h' } });

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    const [refetchUrl] = h.fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(refetchUrl).toBe('/api/plugins/usage?period=24h');
  });
});
