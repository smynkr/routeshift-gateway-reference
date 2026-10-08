// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  ExperimentStatusBadge,
  ShadowExperimentsClient,
} from '@/app/(dashboard)/shadow-experiments/shadow-experiments-client';
import { ExperimentEditor } from '@/components/shadow-experiments/experiment-editor';
import { ModelAutocomplete } from '@/components/models/model-autocomplete';
import type { ShadowExperimentRow } from '@/lib/shadow-experiments';

afterEach(cleanup);

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

function rowWith(overrides: Partial<ShadowExperimentRow>): ShadowExperimentRow {
  return {
    id: 'exp_1',
    team_id: 'team_1',
    name: 'Candidate eval',
    enabled: false,
    source_provider: 'openai',
    source_model: 'gpt-5',
    candidate_provider: 'anthropic',
    candidate_model: 'claude-sonnet-4-6',
    sample_rate_ppm: 50_000,
    sampling_version: 'v1',
    shadow_sampling_key_version: 'key-v1',
    starts_at: null,
    ends_at: null,
    max_samples: 1_000,
    deadline_ms: 30_000,
    max_concurrency: 2,
    max_queue_count: 100,
    max_queue_bytes: 10_485_760,
    max_payload_bytes: 1_048_576,
    funding_mode: 'platform_funded',
    per_run_cap_microcents: 50_000_000,
    aggregate_cap_microcents: 5_000_000_000,
    verifier_version: 'rsh72-v1',
    gate_fingerprint: 'sha256:ab12',
    consent_provider_ack: false,
    consent_region_ack: false,
    consent_privacy_ack: false,
    approved_by: null,
    approved_at: null,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
    created_by: null,
    disabled_reason: null,
    kill_switch_at: null,
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

describe('ExperimentStatusBadge', () => {
  it('renders every truthful status label', () => {
    for (const [status, label] of [
      ['disabled', 'Disabled'],
      ['enabled', 'Enabled'],
      ['quarantined', 'Quarantined'],
      ['killed', 'Killed'],
    ] as const) {
      const { unmount } = render(<ExperimentStatusBadge status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });
});

describe('ModelAutocomplete disabled state', () => {
  it('does not render the clear (×) button when disabled', () => {
    render(<ModelAutocomplete value="gpt-5" onChange={() => undefined} disabled />);
    expect(screen.queryByLabelText('Clear model selection')).toBeNull();
  });

  it('still renders the clear button when enabled with a value', () => {
    render(<ModelAutocomplete value="gpt-5" onChange={() => undefined} />);
    expect(screen.getByLabelText('Clear model selection')).toBeTruthy();
  });
});

describe('ShadowExperimentsClient proxy states', () => {
  it('shows the informational flag-off state for 404 shadow_routing_disabled, not an error', async () => {
    h.fetch.mockResolvedValue(
      jsonResponse(404, { error: { message: 'Shadow routing is not enabled', code: 'shadow_routing_disabled' } }),
    );

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('Shadow routing is not enabled')).toBeTruthy());
    expect(screen.getByText(/SHADOW_ROUTING_ENABLED/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the house error state with retry when the fetch fails', async () => {
    h.fetch.mockRejectedValue(new Error('network down'));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Failed to load shadow experiments.')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('surfaces proxy error codes verbatim on non-404 failures', async () => {
    h.fetch.mockResolvedValue(jsonResponse(500, { error: { message: 'Boom', code: 'internal' } }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Boom')).toBeTruthy();
    expect(screen.getByText('internal')).toBeTruthy();
  });

  it('rejects an invalid response shape instead of rendering untrusted rows', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { wrong: true }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('Received an invalid shadow experiments response.')).toBeTruthy());
  });

  it('renders the table with route, display percent, status badges, and USD caps', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, {
      experiments: [
        rowWith({ id: 'exp_1', name: 'Plain disabled' }),
        rowWith({ id: 'exp_2', name: 'Quarantined one', disabled_reason: 'invalid_execution_bound_contract' }),
        rowWith({ id: 'exp_3', name: 'Killed one', kill_switch_at: '2026-08-02T00:00:00Z' }),
      ],
    }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('Plain disabled')).toBeTruthy());
    expect(screen.getByText('Quarantined one')).toBeTruthy();
    expect(screen.getByText('Killed one')).toBeTruthy();
    expect(screen.getAllByText('5%').length).toBe(3);
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getByText('Quarantined')).toBeTruthy();
    expect(screen.getByText('Killed')).toBeTruthy();
    expect(screen.getAllByText('$0.5 / $50').length).toBe(3);
    expect(screen.getAllByText('gpt-5').length).toBe(3);
    expect(screen.getAllByText('claude-sonnet-4-6').length).toBe(3);
  });

  it('never offers an enable toggle anywhere', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { experiments: [rowWith({})] }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('Candidate eval')).toBeTruthy());
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByLabelText(/enable experiment/i)).toBeNull();
    expect(screen.getByText(/shadow_enablement_unavailable/)).toBeTruthy();
  });

  it('shows the truthful no-telemetry line in the expanded row', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { experiments: [rowWith({})] }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('Candidate eval')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Expand experiment Candidate eval' }));

    await waitFor(() =>
      expect(
        screen.getByText(/Execution telemetry \(shadow_runs\) is not written yet — shadow execution \(RSH-85 Phase 2\) is on hold\./),
      ).toBeTruthy(),
    );
    expect(screen.getByText('sha256:ab12')).toBeTruthy();
  });

  it('hides every write control and shows the read-only banner when canManage is false', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { experiments: [rowWith({})] }));

    render(<ShadowExperimentsClient canManage={false} demo={false} readOnlyReason="Only admins can manage." />);

    await waitFor(() => expect(screen.getByText('Candidate eval')).toBeTruthy());
    expect(screen.getByText('Only admins can manage.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New experiment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit Candidate eval' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Candidate eval' })).toBeNull();
  });

  it('rejects a row missing a dereferenced numeric field into the invalid-response state', async () => {
    const broken = rowWith({});
    delete (broken as Partial<ShadowExperimentRow>).max_samples;
    h.fetch.mockResolvedValue(jsonResponse(200, { experiments: [broken] }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() =>
      expect(screen.getByText('Received an invalid shadow experiments response.')).toBeTruthy(),
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Candidate eval')).toBeNull();
  });

  it('deletes via the encoded id and refetches after confirmation', async () => {
    const row = rowWith({ id: 'exp/1', name: 'To delete' });
    h.fetch
      .mockResolvedValueOnce(jsonResponse(200, { experiments: [row] }))
      .mockResolvedValueOnce(jsonResponse(200, { deleted: true }))
      .mockResolvedValueOnce(jsonResponse(200, { experiments: [] }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('To delete')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete To delete' }));

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete To delete' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(3));
    const [deleteUrl, deleteInit] = h.fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(deleteUrl).toBe('/api/shadow-experiments/exp%2F1');
    expect(deleteInit.method).toBe('DELETE');
  });

  it('shows the delete failure message and proxy code verbatim in the dialog', async () => {
    h.fetch
      .mockResolvedValueOnce(jsonResponse(200, { experiments: [rowWith({})] }))
      .mockResolvedValueOnce(
        jsonResponse(404, { error: { message: 'Experiment not found', code: 'not_found' } }),
      );

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('Candidate eval')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Candidate eval' }));

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Candidate eval' }));

    await waitFor(() => expect(screen.getByText('Experiment not found')).toBeTruthy());
    expect(screen.getByText('not_found')).toBeTruthy();
  });

  it('surfaces a flat-string proxy error verbatim in the delete dialog (not the fallback)', async () => {
    h.fetch
      .mockResolvedValueOnce(jsonResponse(200, { experiments: [rowWith({})] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Scoped token lacks delete rights' }), { status: 403 }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('Candidate eval')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Candidate eval' }));

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Candidate eval' }));

    await waitFor(() => expect(screen.getByText('Scoped token lacks delete rights')).toBeTruthy());
    expect(screen.queryByText('Failed to delete experiment.')).toBeNull();
  });

  it('keeps the dialog open and shows the code when the delete route answers 502 with an envelope', async () => {
    h.fetch
      .mockResolvedValueOnce(jsonResponse(200, { experiments: [rowWith({})] }))
      .mockResolvedValueOnce(
        jsonResponse(502, { error: { message: 'Proxy unavailable', code: 'proxy_unavailable' } }),
      );

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() => expect(screen.getByText('Candidate eval')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Candidate eval' }));

    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Candidate eval' }));

    await waitFor(() => expect(screen.getByText('Proxy unavailable')).toBeTruthy());
    expect(screen.getByText('proxy_unavailable')).toBeTruthy();
    // The delete did not succeed, so the confirmation dialog must stay mounted.
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Candidate eval')).toBeTruthy();
  });

  it('rejects a row with a negative cap into the invalid-response state', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { experiments: [rowWith({ per_run_cap_microcents: -1 })] }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() =>
      expect(screen.getByText('Received an invalid shadow experiments response.')).toBeTruthy(),
    );
    expect(screen.queryByText('Candidate eval')).toBeNull();
  });

  it('rejects a row with an out-of-range sample_rate_ppm into the invalid-response state', async () => {
    h.fetch.mockResolvedValue(jsonResponse(200, { experiments: [rowWith({ sample_rate_ppm: 2_000_000 })] }));

    render(<ShadowExperimentsClient canManage demo={false} readOnlyReason="" />);

    await waitFor(() =>
      expect(screen.getByText('Received an invalid shadow experiments response.')).toBeTruthy(),
    );
    expect(screen.queryByText('Candidate eval')).toBeNull();
  });
});

describe('ExperimentEditor client-side validation', () => {
  function renderEditor() {
    return render(
      <ExperimentEditor mode="create" onClose={() => undefined} onSaved={async () => undefined} />,
    );
  }

  function fillValidIdentity() {
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Eval' } });
    fireEvent.change(screen.getByLabelText('Source model'), { target: { value: 'gpt-5' } });
    fireEvent.change(screen.getByLabelText('Candidate model'), { target: { value: 'claude-sonnet-4-6' } });
    fireEvent.change(screen.getByLabelText('Sampling version'), { target: { value: 'v1' } });
    fireEvent.change(screen.getByLabelText('Shadow sampling key version'), { target: { value: 'key-v1' } });
    fireEvent.change(screen.getByLabelText('Verifier version'), { target: { value: 'rsh72-v1' } });
    fireEvent.change(screen.getByLabelText('Gate fingerprint'), { target: { value: 'sha256:ab12' } });
  }

  function fillValidBounds() {
    fireEvent.change(screen.getByLabelText('Sample rate (%)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Max samples'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Deadline (ms)'), { target: { value: '30000' } });
    fireEvent.change(screen.getByLabelText('Max concurrency'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Max queue count'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Max queue bytes'), { target: { value: '10485760' } });
    fireEvent.change(screen.getByLabelText('Max payload bytes'), { target: { value: '1048576' } });
    fireEvent.change(screen.getByLabelText('Per-run cap (USD)'), { target: { value: '0.50' } });
    fireEvent.change(screen.getByLabelText('Aggregate cap (USD)'), { target: { value: '50' } });
  }

  function fillValidForm() {
    fillValidIdentity();
    fillValidBounds();
  }

  it('requires a name before anything else', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Name is required.')).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('requires the identity models and versions in order', () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Eval' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));
    expect(screen.getByText('Source model is required.')).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('rejects a sample rate that cannot be stored as whole ppm', () => {
    renderEditor();
    fillValidForm();
    fireEvent.change(screen.getByLabelText('Sample rate (%)'), { target: { value: '0.00001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));
    expect(screen.getByText(/stored as whole ppm/)).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('mirrors the proxy bound ranges for integer fields', () => {
    renderEditor();
    fillValidForm();
    fireEvent.change(screen.getByLabelText('Max samples'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));
    expect(screen.getByText(/max_samples must be a whole number between 0 and 2,147,483,647/)).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reports an emptied bound field as required', () => {
    renderEditor();
    fillValidForm();
    fireEvent.change(screen.getByLabelText('Max samples'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));
    expect(screen.getByText('Max samples is required.')).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reports a non-integer bound field with the range message, not "required"', () => {
    renderEditor();
    fillValidForm();
    fireEvent.change(screen.getByLabelText('Max samples'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));
    expect(screen.getByText(/max_samples must be a whole number between 0 and 2,147,483,647/)).toBeTruthy();
    expect(screen.queryByText('Max samples is required.')).toBeNull();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('surfaces the aggregate >= per_run violation with the proxy message verbatim', () => {
    renderEditor();
    fillValidForm();
    fireEvent.change(screen.getByLabelText('Per-run cap (USD)'), { target: { value: '1.00' } });
    fireEvent.change(screen.getByLabelText('Aggregate cap (USD)'), { target: { value: '0.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));
    expect(screen.getByText(/aggregate_cap_microcents must be >= per_run_cap_microcents/)).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('submits a valid create with ppm conversion and USD→microcent conversion', async () => {
    h.fetch.mockResolvedValueOnce(jsonResponse(201, { experiment: rowWith({}) }));
    renderEditor();
    fillValidForm();

    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/shadow-experiments');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.sample_rate_ppm).toBe(50_000);
    expect(body.per_run_cap_microcents).toBe(50_000_000);
    expect(body.aggregate_cap_microcents).toBe(5_000_000_000);
    expect(body.enabled).toBeUndefined();
  });

  it('shows proxy rejection message and code verbatim on submit failure', async () => {
    h.fetch.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { message: 'sample_rate_ppm must be an integer in [0, 1000000]', code: 'invalid_sample_rate' },
      }),
    );
    renderEditor();
    fillValidForm();

    fireEvent.click(screen.getByRole('button', { name: 'Create experiment' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('sample_rate_ppm must be an integer in [0, 1000000]')).toBeTruthy();
    expect(screen.getByText('invalid_sample_rate')).toBeTruthy();
  });
});

describe('ExperimentEditor edit mode', () => {
  function renderEditEditor(row: ShadowExperimentRow) {
    return render(
      <ExperimentEditor mode="edit" experiment={row} onClose={() => undefined} onSaved={async () => undefined} />,
    );
  }

  it('reports "No changes to save." when an unmodified experiment is submitted', () => {
    renderEditEditor(rowWith({}));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('No changes to save.')).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('sends exactly { name } when only the name changes', async () => {
    h.fetch.mockResolvedValueOnce(jsonResponse(200, { experiment: rowWith({ name: 'Renamed' }) }));
    renderEditEditor(rowWith({}));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/shadow-experiments/exp_1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Renamed' });
  });

  it('disables identity/version fields but keeps the sample rate editable', () => {
    renderEditEditor(rowWith({}));
    expect((screen.getByLabelText('Source model') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Candidate model') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Sampling version') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Shadow sampling key version') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Verifier version') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Gate fingerprint') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Sample rate (%)') as HTMLInputElement).disabled).toBe(false);
  });

  it('prefills a large stored cap and does not re-send untouched caps (drift regression)', async () => {
    const drifted = rowWith({
      per_run_cap_microcents: 7778758330654,
      aggregate_cap_microcents: Number.MAX_SAFE_INTEGER,
    });
    h.fetch.mockResolvedValueOnce(jsonResponse(200, { experiment: drifted }));
    renderEditEditor(drifted);

    expect((screen.getByLabelText('Per-run cap (USD)') as HTMLInputElement).value).toBe('77787.58330654');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ name: 'Renamed' });
    expect(body.per_run_cap_microcents).toBeUndefined();
    expect(body.aggregate_cap_microcents).toBeUndefined();
  });

  it('prefills a 1-microcent cap as a plain decimal (not "1e-8") and submits unchanged (wedge regression)', () => {
    const tiny = rowWith({ per_run_cap_microcents: 1, aggregate_cap_microcents: 1 });
    renderEditEditor(tiny);

    expect((screen.getByLabelText('Per-run cap (USD)') as HTMLInputElement).value).toBe('0.00000001');
    expect((screen.getByLabelText('Aggregate cap (USD)') as HTMLInputElement).value).toBe('0.00000001');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText('No changes to save.')).toBeTruthy();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('sends exactly { name } on rename when the stored aggregate cap is MAX_SAFE_INTEGER (drift regression)', async () => {
    const drifted = rowWith({ aggregate_cap_microcents: 9007199254740991 });
    h.fetch.mockResolvedValueOnce(jsonResponse(200, { experiment: drifted }));
    renderEditEditor(drifted);

    expect((screen.getByLabelText('Aggregate cap (USD)') as HTMLInputElement).value).toBe('90071992.54740991');

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Renamed' });
  });

  it('sends starts_at: null when the window start is cleared', async () => {
    const withWindow = rowWith({ starts_at: '2026-08-10T10:00:00Z' });
    h.fetch.mockResolvedValueOnce(jsonResponse(200, { experiment: withWindow }));
    renderEditEditor(withWindow);

    expect((screen.getByLabelText('Starts at') as HTMLInputElement).value)
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);

    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.starts_at).toBeNull();
    expect(body.name).toBe('Renamed');
  });

  it('does not close and shows the error verbatim when a 2xx response carries an error envelope', async () => {
    const onClose = vi.fn();
    h.fetch.mockResolvedValueOnce(jsonResponse(200, { error: { message: 'x', code: 'y' } }));
    render(
      <ExperimentEditor mode="edit" experiment={rowWith({})} onClose={onClose} onSaved={async () => undefined} />,
    );

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('x')).toBeTruthy();
    expect(screen.getByText('y')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renames a row whose stored caps violate aggregate>=per_run without re-sending caps (no lock-out)', async () => {
    const inverted = rowWith({ per_run_cap_microcents: 5_000_000, aggregate_cap_microcents: 1_000_000 });
    h.fetch.mockResolvedValueOnce(jsonResponse(200, { experiment: inverted }));
    renderEditEditor(inverted);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Renamed' });
  });

  it('includes starts_at in the PATCH when a sub-second-stored window is edited (no tolerance masking)', async () => {
    const withMs = rowWith({ starts_at: '2026-08-10T10:00:00.500Z' });
    h.fetch.mockResolvedValueOnce(jsonResponse(200, { experiment: withMs }));
    renderEditEditor(withMs);

    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '2026-08-10T10:00:01' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const [, init] = h.fetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toHaveProperty('starts_at');
    expect(body.name).toBe('Renamed');
  });
});
