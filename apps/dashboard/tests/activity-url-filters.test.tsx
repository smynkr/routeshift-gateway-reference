// @vitest-environment jsdom

import type { ReactNode } from 'react';
import type * as ReactTypes from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityFilters } from '@/lib/activity-filters';
import type { ActivityLog } from '@/lib/activity-log';

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const transition = vi.hoisted(() => ({ pending: false }));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactTypes>('react');
  return {
    ...actual,
    useTransition: () => [
      transition.pending,
      (callback: () => void) => callback(),
    ] as const,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

import { ActivityClient } from '@/app/(dashboard)/activity/activity-client';

const emptyResponse: {
  logs: ActivityLog[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
} = {
  logs: [],
  total: 0,
  page: 1,
  limit: 50,
  totalPages: 1,
};
const paginationLog: ActivityLog = {
  id: 'req_1',
  timestamp: '2026-08-26T12:00:00.000Z',
  provider: 'openai',
  model_requested: 'gpt-5.4',
  model_resolved: 'gpt-5.4',
  input_tokens: 1,
  output_tokens: 1,
  total_tokens: 2,
  original_cost_microcents: 1,
  actual_cost_microcents: 1,
  actual_cost_known: true,
  plugin_cost_microcents: 0,
  billed_cost_microcents: 1,
  savings_microcents: 0,
  total_latency_ms: 1,
  ttft_ms: null,
  is_streaming: false,
  is_fallback: false,
  fallback_attempts: [],
  plugin_warnings: [],
  status_code: 200,
  error_type: null,
  cache_hit: false,
  activity_category: null,
  session_id: null,
  api_key_id: null,
};

const initialFilters: ActivityFilters = {
  provider: 'openai',
  model: 'gpt-5',
  resolved_model: 'gpt-5.4',
  status: 'error',
  from: '2026-08-19T12:00:00.000Z',
  to: '2026-08-26T12:00:00.000Z',
};
const populatedInitialFilters: ActivityFilters = {
  ...initialFilters,
  category: 'coding',
  api_key_id: 'key_1',
  session: 'session_1',
};

type ActivityPayload = typeof emptyResponse;
type MockResponse = {
  ok: boolean;
  json: () => Promise<ActivityPayload>;
};

function responseFor(request: string, logs: ActivityLog[] = []): MockResponse {
  const page = Number(new URL(request, 'http://localhost').searchParams.get('page') ?? '1');
  return {
    ok: true,
    json: async () => ({ ...emptyResponse, logs, page }),
  };
}

describe('Activity URL filter behavior', () => {
  const fetchMock = vi.fn((request: string) => Promise.resolve(responseFor(request)));

  beforeEach(() => {
    vi.useFakeTimers();
    transition.pending = false;
    fetchMock.mockReset();
    fetchMock.mockImplementation((request: string) => Promise.resolve(responseFor(request)));
    navigation.replace.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('initializes controls and forwards every URL filter to the first logs request', async () => {
    render(<ActivityClient initialFilters={initialFilters} />);
    expect(fetchMock).toHaveBeenCalled();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstRequest = new URL(fetchMock.mock.calls[0]![0], 'http://localhost');
    expect(firstRequest.pathname).toBe('/api/logs');
    expect(Object.fromEntries(firstRequest.searchParams)).toMatchObject({
      provider: 'openai',
      model: 'gpt-5',
      resolved_model: 'gpt-5.4',
      status: 'error',
      from: '2026-08-19T12:00:00.000Z',
      to: '2026-08-26T12:00:00.000Z',
    });
    expect(screen.getByDisplayValue('openai')).toBeTruthy();
    expect(screen.getByDisplayValue('gpt-5')).toBeTruthy();
    expect(screen.getByText('Resolved model gpt-5.4')).toBeTruthy();
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('error');
  });

  it('replaces the URL with the complete normalized filter state when a filter changes', async () => {
    render(<ActivityClient initialFilters={initialFilters} />);
    expect(fetchMock).toHaveBeenCalled();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });

    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/activity?provider=anthropic&model=gpt-5&resolved_model=gpt-5.4&status=error&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
      { scroll: false },
    );
  });

  it('clears the exact resolved-model chip without changing the manual model input', async () => {
    render(<ActivityClient initialFilters={initialFilters} />);
    expect(fetchMock).toHaveBeenCalled();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear resolved model filter' }));

    expect(screen.getByDisplayValue('gpt-5')).toBeTruthy();
    expect(screen.queryByText('Resolved model gpt-5.4')).toBeNull();
    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/activity?provider=openai&model=gpt-5&status=error&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
      { scroll: false },
    );
  });
  it('resynchronizes every filter when server-provided initial filters change', async () => {
    const { rerender } = render(<ActivityClient initialFilters={populatedInitialFilters} />);
    expect(fetchMock).toHaveBeenCalled();
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    navigation.replace.mockClear();
    rerender(<ActivityClient initialFilters={{}} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('');
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('');
    expect((screen.getAllByRole('combobox')[2] as HTMLSelectElement).value).toBe('');
    expect((screen.getByPlaceholderText('Filter by model...') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTitle('key_1')).toBeNull();
    expect(screen.queryByTitle('session_1')).toBeNull();

    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.has('provider')).toBe(false);
    expect(latestRequest.searchParams.has('model')).toBe(false);
    expect(latestRequest.searchParams.has('resolved_model')).toBe(false);
    expect(latestRequest.searchParams.has('status')).toBe(false);
    expect(latestRequest.searchParams.has('category')).toBe(false);
    expect(latestRequest.searchParams.has('api_key_id')).toBe(false);
    expect(latestRequest.searchParams.has('session')).toBe(false);
    expect(latestRequest.searchParams.has('from')).toBe(false);
    expect(latestRequest.searchParams.has('to')).toBe(false);
  });


  it('clears filters in the URL and resets local pagination to page one', async () => {
    vi.useRealTimers();
    fetchMock.mockImplementation((request: string) => {
      const page = Number(new URL(request, 'http://localhost').searchParams.get('page') ?? '1');
      return Promise.resolve({
        ok: true,
        json: async () => ({ ...emptyResponse, logs: [paginationLog], page, total: 51, totalPages: 2 }),
      });
    });

    render(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    expect(fetchMock).toHaveBeenCalled();
    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(navigation.replace).toHaveBeenLastCalledWith('/activity', { scroll: false });
    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();
    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.get('page')).toBe('1');
    expect(latestRequest.searchParams.has('provider')).toBe(false);
  });
  it('normalizes a padded session ID before showing, replacing, and fetching it', async () => {
    vi.useRealTimers();
    const sessionLog = { ...paginationLog, id: 'req_session', session_id: ' session_1 ' };
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: async () => ({ ...emptyResponse, logs: [sessionLog], total: 1 }),
    }));

    render(<ActivityClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand request req_session' }));
    fireEvent.click(screen.getByTitle(/Filter activity by session/));

    const titles = Array.from(document.querySelectorAll('[title]'), (element) => element.getAttribute('title'));
    expect(titles).toContain('session_1');
    expect(titles).not.toContain(' session_1 ');
    expect(navigation.replace).toHaveBeenLastCalledWith('/activity?session=session_1', { scroll: false });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.get('session')).toBe('session_1');
  });

  it('rejects oversized session IDs from expanded rows before UI, URL, or API state', async () => {
    vi.useRealTimers();
    const oversizedSession = 'x'.repeat(257);
    const sessionLog = { ...paginationLog, id: 'req_oversized_session', session_id: oversizedSession };
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: async () => ({ ...emptyResponse, logs: [sessionLog], total: 1 }),
    }));

    const { rerender } = render(<ActivityClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand request req_oversized_session' }));
    fireEvent.click(screen.getByTitle(/Filter activity by session/));

    expect(screen.queryByTitle(oversizedSession)).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.has('session')).toBe(false);
    rerender(<ActivityClient initialFilters={{ session: 'browser_back' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTitle('browser_back')).toBeTruthy();
  });

  it('rejects blank session IDs from expanded rows before UI, URL, or API state', async () => {
    vi.useRealTimers();
    const sessionLog = { ...paginationLog, id: 'req_blank_session', session_id: '   ' };
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: async () => ({ ...emptyResponse, logs: [sessionLog], total: 1 }),
    }));

    const { rerender } = render(<ActivityClient />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand request req_blank_session' }));
    fireEvent.click(screen.getByTitle(/Filter activity by session/));

    expect(screen.queryByRole('button', { name: 'Clear session filter' })).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.has('session')).toBe(false);
    rerender(<ActivityClient initialFilters={{ session: 'browser_back' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTitle('browser_back')).toBeTruthy();
  });
  it('ignores invalid row sessions without clearing an active session filter', async () => {
    vi.useRealTimers();
    const invalidSessionLog = { ...paginationLog, id: 'req_invalid_active', session_id: 'x'.repeat(257) };
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: async () => ({ ...emptyResponse, logs: [invalidSessionLog], total: 1 }),
    }));

    render(<ActivityClient initialFilters={{ session: 'active_session' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand request req_invalid_active' }));
    expect(screen.getByTitle('active_session')).toBeTruthy();
    navigation.replace.mockClear();
    fetchMock.mockClear();
    fireEvent.click(screen.getByTitle(/Filter activity by session/));

    expect(screen.getByTitle('active_session')).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not arm pending navigation for the same active session and applies later browser navigation', async () => {
    vi.useRealTimers();
    const sessionLog = { ...paginationLog, id: 'req_same_session', session_id: 'session_1' };
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true,
      json: async () => ({ ...emptyResponse, logs: [sessionLog], total: 1 }),
    }));

    const { rerender } = render(<ActivityClient initialFilters={{ session: 'session_1' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Expand request req_same_session' }));
    navigation.replace.mockClear();
    fetchMock.mockClear();

    fireEvent.click(screen.getByTitle(/Filter activity by session/));

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(<ActivityClient initialFilters={{ session: 'session_back' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTitle('session_back')).toBeTruthy();
    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.get('session')).toBe('session_back');
  });

  it('treats padded-equivalent model text as a no-op before browser navigation', async () => {
    const { rerender } = render(<ActivityClient initialFilters={{ model: 'gpt-5' }} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fetchMock.mockClear();
    navigation.replace.mockClear();

    fireEvent.change(screen.getByPlaceholderText('Filter by model...'), { target: { value: '  gpt-5  ' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    rerender(<ActivityClient initialFilters={{ model: 'gpt-5.5' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('gpt-5.5')).toBeTruthy();
  });

  it('commits the manual model to URL and API together after 300ms, merging latest non-model filters', async () => {
    render(<ActivityClient initialFilters={initialFilters} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fetchMock.mockClear();
    navigation.replace.mockClear();

    fireEvent.change(screen.getByPlaceholderText('Filter by model...'), { target: { value: 'gpt-5.5' } });
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/activity?provider=anthropic&model=gpt-5&resolved_model=gpt-5.4&status=error&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
      { scroll: false },
    );
    const nonModelRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(nonModelRequest.searchParams.get('provider')).toBe('anthropic');
    expect(nonModelRequest.searchParams.get('model')).toBe('gpt-5');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/activity?provider=anthropic&model=gpt-5.5&resolved_model=gpt-5.4&status=error&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
      { scroll: false },
    );
    const committedRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(committedRequest.searchParams.get('provider')).toBe('anthropic');
    expect(committedRequest.searchParams.get('model')).toBe('gpt-5.5');
  });

  it('preserves a pending manual model draft across router-driven non-model rerenders', async () => {
    const { rerender } = render(<ActivityClient initialFilters={initialFilters} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fetchMock.mockClear();
    navigation.replace.mockClear();

    fireEvent.change(screen.getByPlaceholderText('Filter by model...'), { target: { value: 'gpt-5.5' } });
    rerender(
      <ActivityClient
        initialFilters={{
          ...initialFilters,
          provider: 'anthropic',
          model: 'gpt-5',
        }}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigation.replace).toHaveBeenLastCalledWith(
      '/activity?provider=anthropic&model=gpt-5.5&resolved_model=gpt-5.4&status=error&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z',
      { scroll: false },
    );
    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.get('provider')).toBe('anthropic');
    expect(latestRequest.searchParams.get('model')).toBe('gpt-5.5');
  });

  it('resets manual and committed model state when the external initial model changes', async () => {
    const { rerender } = render(<ActivityClient initialFilters={initialFilters} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    fetchMock.mockClear();

    rerender(<ActivityClient initialFilters={{ ...initialFilters, model: 'gpt-5.5' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByDisplayValue('gpt-5.5')).toBeTruthy();
    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.get('model')).toBe('gpt-5.5');
  });

  it('shows a fixed UTC range and restores live refresh when the range is cleared', async () => {
    render(
      <ActivityClient
        initialFilters={{
          from: '2026-08-19T12:00:00.000Z',
          to: '2026-08-26T12:00:00.000Z',
        }}
      />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('UTC range: 2026-08-19T12:00:00.000Z → 2026-08-26T12:00:00.000Z')).toBeTruthy();
    const fixedRangeButton = screen.getByRole('button', { name: 'Fixed range' }) as HTMLButtonElement;
    expect(fixedRangeButton.disabled).toBe(true);
    expect(fixedRangeButton.className).toContain('disabled:cursor-not-allowed');
    expect(fixedRangeButton.className).toContain('disabled:opacity-60');
    expect(screen.getByText('Clear the time range to restore live refresh.')).toBeTruthy();

    fetchMock.mockClear();
    navigation.replace.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Clear time range filter' }));

    expect(navigation.replace).toHaveBeenLastCalledWith('/activity', { scroll: false });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const latestRequest = new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost');
    expect(latestRequest.searchParams.has('from')).toBe(false);
    expect(latestRequest.searchParams.has('to')).toBe(false);
  });

  it('reissues a rapid provider reversion and rejects stale middle props', async () => {
    const { rerender } = render(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    transition.pending = true;
    rerender(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    fetchMock.mockClear();
    navigation.replace.mockClear();

    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByDisplayValue('anthropic'), { target: { value: 'openai' } });

    expect(navigation.replace).toHaveBeenCalledTimes(2);
    expect(navigation.replace).toHaveBeenLastCalledWith('/activity?provider=openai', { scroll: false });

    rerender(<ActivityClient initialFilters={{ provider: 'anthropic' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('openai')).toBeTruthy();
    expect(new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost').searchParams.get('provider')).toBe('openai');

    transition.pending = false;
    rerender(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender(<ActivityClient initialFilters={{ provider: 'anthropic' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('anthropic')).toBeTruthy();
  });

  it('keeps a rapid Clear reversion synchronized through stale and matching props', async () => {
    const { rerender } = render(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    transition.pending = true;
    rerender(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(navigation.replace).toHaveBeenLastCalledWith('/activity', { scroll: false });

    rerender(<ActivityClient initialFilters={{ provider: 'anthropic' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('');

    transition.pending = false;
    rerender(<ActivityClient initialFilters={{}} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('openai')).toBeTruthy();
  });

  it('keeps a rapid time-range Clear reversion synchronized', async () => {
    const range = {
      from: '2026-08-19T12:00:00.000Z',
      to: '2026-08-26T12:00:00.000Z',
    };
    const { rerender } = render(<ActivityClient initialFilters={range} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    transition.pending = true;
    rerender(<ActivityClient initialFilters={range} />);
    navigation.replace.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Clear time range filter' }));
    expect(navigation.replace).toHaveBeenLastCalledWith('/activity', { scroll: false });

    rerender(<ActivityClient initialFilters={range} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'Clear time range filter' })).toBeNull();

    transition.pending = false;
    rerender(<ActivityClient initialFilters={{}} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender(<ActivityClient initialFilters={range} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Clear time range filter' })).toBeDefined();
  });

  it('ignores stale server props after sequential navigations until matching props arrive', async () => {
    const { rerender } = render(
      <ActivityClient initialFilters={{ ...initialFilters, status: 'success' }} />,
    );
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    transition.pending = true;
    rerender(
      <ActivityClient initialFilters={{ ...initialFilters, status: 'success' }} />,
    );
    fetchMock.mockClear();
    navigation.replace.mockClear();

    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });
    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'error' } });
    const latestUrl = '/activity?provider=anthropic&model=gpt-5&resolved_model=gpt-5.4&status=error&from=2026-08-19T12%3A00%3A00.000Z&to=2026-08-26T12%3A00%3A00.000Z';
    expect(navigation.replace).toHaveBeenLastCalledWith(latestUrl, { scroll: false });

    // A stale response for the first provider-only navigation must not roll
    // back the status or issue a request for the stale snapshot.
    rerender(
      <ActivityClient initialFilters={{ ...initialFilters, provider: 'anthropic', status: 'success' }} />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('anthropic');
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('error');
    expect(new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost').searchParams.get('status')).toBe('error');

    // The latest server round-trip matches the pending snapshot and clears
    // the token; browser/back navigation then applies normally.
    transition.pending = false;
    rerender(
      <ActivityClient initialFilters={{ ...initialFilters, provider: 'anthropic', status: 'error' }} />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender(<ActivityClient initialFilters={{ ...initialFilters, provider: 'openai', status: 'success' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('openai');
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('success');
    expect(new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost').searchParams.get('provider')).toBe('openai');
    expect(new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost').searchParams.get('status')).toBe('success');
  });

  it('releases pending state after a value-equal final transition before external navigation', async () => {
    const { rerender } = render(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByDisplayValue('anthropic'), { target: { value: 'openai' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The final props have the same values as the original A snapshot, so no
    // prop-value effect can acknowledge the local A reversion.
    rerender(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    rerender(<ActivityClient initialFilters={{ provider: 'anthropic' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('anthropic')).toBeTruthy();
    expect(new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost').searchParams.get('provider')).toBe('anthropic');
  });

  it('clears intermediate navigation tombstones when value-equal final A settles without prop changes', async () => {
    const { rerender } = render(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    transition.pending = true;
    rerender(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByDisplayValue('anthropic'), { target: { value: 'openai' } });
    transition.pending = false;
    rerender(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    // The A props remain value-equal; only the controlled transition lifecycle
    // rerender settles the latest generation before external B arrives.
    rerender(<ActivityClient initialFilters={{ provider: 'anthropic' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('anthropic')).toBeTruthy();
    expect(new URL(fetchMock.mock.calls.at(-1)![0], 'http://localhost').searchParams.get('provider')).toBe('anthropic');
  });

  it('keeps the newest pending generation when local transitions overlap', async () => {
    const { rerender } = render(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByDisplayValue('anthropic'), { target: { value: 'google' } });
    expect(navigation.replace).toHaveBeenCalledTimes(2);
    expect(navigation.replace).toHaveBeenLastCalledWith('/activity?provider=google', { scroll: false });

    rerender(<ActivityClient initialFilters={{ provider: 'google' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('google')).toBeTruthy();

    rerender(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByDisplayValue('openai')).toBeTruthy();
  });

  it('never paints an older out-of-order response after a newer filter request', async () => {
    const pending: Array<{ url: string; resolve: (response: MockResponse) => void }> = [];
    fetchMock.mockImplementation((request: string) => {
      const { promise, resolve } = Promise.withResolvers<MockResponse>();
      pending.push({ url: request, resolve });
      return promise;
    });

    render(<ActivityClient initialFilters={{ provider: 'openai' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pending).toHaveLength(1);

    fireEvent.change(screen.getByDisplayValue('openai'), { target: { value: 'anthropic' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pending).toHaveLength(2);

    const first = { ...paginationLog, id: 'request-A', provider: 'openai', model_resolved: 'model-A' };
    const second = { ...paginationLog, id: 'request-B', provider: 'anthropic', model_resolved: 'model-B' };
    await act(async () => {
      pending[1]!.resolve(responseFor(pending[1]!.url, [second]));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('model-B')).toBeTruthy();

    await act(async () => {
      pending[0]!.resolve(responseFor(pending[0]!.url, [first]));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('model-B')).toBeTruthy();
    expect(screen.queryByText('model-A')).toBeNull();
  });
});
