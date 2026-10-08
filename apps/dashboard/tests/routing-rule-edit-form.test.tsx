// @vitest-environment jsdom

import { cleanup, render, screen, act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import EditRulePage from '@/app/(dashboard)/routing/[id]/page';

const h = vi.hoisted(() => ({
  params: { id: 'rule-9' },
  fetchMock: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => h.params,
  useRouter: () => ({ push: h.push }),
  useSearchParams: () => ({ get: () => null }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <span aria-hidden="true" />,
  Loader2: () => <span aria-hidden="true" />,
}));
vi.mock('@/components/models/model-autocomplete', () => ({
  ModelAutocomplete: ({ id, value, onChange, placeholder }: { id?: string; value: string; onChange: (value: string) => void; placeholder?: string }) => (
    <input id={id} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
  ),
}));
// The real QualityGateEditor renders; no mock needed — the gate round-trip
// assertions exercise the actual component.

const ROUTE_RULE = {
  id: 'rule-9',
  team_id: 'team-1',
  name: 'Gated cheap route',
  priority: 420,
  enabled: true,
  condition: { model_requested: 'gpt-4.1', tags: ['internal'], max_input_tokens: 8000 },
  action: {
    type: 'route',
    target_provider: 'google',
    target_model: 'gemini-3.1-flash',
    fallback_chain: [{ provider: 'openai', model: 'gpt-5.4-nano' }],
    quality_gate: {
      version: 1,
      mode: 'cascade',
      on_stream: 'bypass',
      unknown_signal: 'reject',
      multi_attempt_billing_ack: true,
      checks: [
        { type: 'nonempty_content', min_chars: 10, allow_tool_only: true },
        { type: 'stop_reason', reject: ['max_tokens'] },
      ],
    },
  },
};

function fireInput(label: string, value: string) {
  // fireEvent.change goes through React's value tracker; direct .value sets
  // are clobbered by React's controlled-input guard.
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  h.fetchMock.mockReset();
  h.push.mockReset();
  global.fetch = h.fetchMock;
  h.params.id = 'rule-9';
});
afterEach(() => cleanup());

describe('edit routing rule surface', () => {
  it('hydrates every editable field from the stored rule', async () => {
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ROUTE_RULE });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Gated cheap route');
    expect((screen.getByLabelText('Priority') as HTMLInputElement).value).toBe('420');
    expect((screen.getByLabelText('Target Provider') as HTMLSelectElement).value).toBe('google');
    expect((screen.getByLabelText('Target Model (optional)') as HTMLInputElement).value).toBe('gemini-3.1-flash');
    expect((screen.getByPlaceholderText('Fallback model') as HTMLInputElement).value).toBe('gpt-5.4-nano');
    expect((screen.getByLabelText('Model Match') as HTMLInputElement).value).toBe('gpt-4.1');
    expect((screen.getByLabelText('Request Tags') as HTMLInputElement).value).toBe('internal');
    expect((screen.getByLabelText('Max Input Tokens') as HTMLInputElement).value).toBe('8000');
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDefined();
  });

  it('round-trips the quality gate config into the editor (checks + ack + on_stream)', async () => {
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ROUTE_RULE });

    await act(async () => {
      render(<EditRulePage />);
    });

    // Gate enabled with two checks hydrated, billing ack checked, on_stream bypass.
    expect((screen.getByRole('checkbox', { name: 'Acknowledge multi-attempt billing' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Check 1 type') as HTMLSelectElement).value).toBe('nonempty_content');
    expect((screen.getByLabelText('Check 2 type') as HTMLSelectElement).value).toBe('stop_reason');
    expect((screen.getByLabelText('Streaming requests') as HTMLSelectElement).value).toBe('bypass');
    // Enabled state flips the toggle's aria-label to "Disable quality gate";
// it is a button with aria-checked, not a checkbox.
expect(screen.getByRole('switch', { name: 'Disable quality gate' }).getAttribute('aria-checked')).toBe('true');
  });

  it('PATCHes the edited rule to /api/rules/{id}', async () => {
    h.fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ROUTE_RULE });
    h.fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ updated: true }) });

    await act(async () => {
      render(<EditRulePage />);
    });

    await act(async () => {
      fireInput('Name', 'Renamed rule');
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });

    // The GET has no init; the PATCH does.
    const patchCall = h.fetchMock.mock.calls.find(([url, init]) => url === '/api/rules/rule-9' && !!init);
    expect(patchCall).toBeDefined();
    const [, init] = patchCall!;
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body);
    expect(body.name).toBe('Renamed rule');
    expect(body.action.type).toBe('route');
    // Edit must never re-enable a disabled rule: `enabled` is absent from the
    // PATCH body (the toggle owns it).
    expect(body.enabled).toBeUndefined();
    // The gate survives the round-trip: enabled → config attached.
    expect(body.action.quality_gate.multi_attempt_billing_ack).toBe(true);
    expect(body.action.quality_gate.checks.length).toBe(2);
    expect(body.action.quality_gate.on_stream).toBe('bypass');
  });

  it('refuses loudly when the rule uses features the editor cannot round-trip', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rule-9',
        team_id: 'team-1',
        name: 'Modify rule',
        priority: 100,
        enabled: true,
        condition: {},
        action: { type: 'modify', modifications: { model_requested: 'x' } },
      }),
    });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/cannot be edited with the rule editor/i)).toBeDefined();
    expect(screen.getByText(/action\.type 'modify'/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
  });

  it('refuses a route rule without a target provider (default would change semantics)', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rule-9',
        team_id: 'team-1',
        name: 'Providerless route',
        priority: 100,
        enabled: true,
        condition: {},
        action: { type: 'route', target_model: 'gpt-5.4-nano' },
      }),
    });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/route actions without a target provider cannot be edited/i)).toBeDefined();
  });

  it('refuses a gate with unrepresentable features instead of dropping them', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rule-9',
        team_id: 'team-1',
        name: 'Future gate',
        priority: 100,
        enabled: true,
        condition: {},
        action: {
          type: 'route',
          target_provider: 'openai',
          quality_gate: {
            version: 2,
            mode: 'cascade',
            on_stream: 'reject',
            unknown_signal: 'reject',
            multi_attempt_billing_ack: true,
            checks: [{ type: 'stop_reason', reject: ['max_tokens'] }],
          },
        },
      }),
    });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/quality gate uses features the editor cannot represent/i)).toBeDefined();
  });

  it('refuses a route rule whose target provider is not a supported provider', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rule-9', team_id: 'team-1', name: 'Strange provider', priority: 100, enabled: true,
        condition: {},
        action: { type: 'route', target_provider: 'azure-openai', target_model: 'gpt-5.5' },
      }),
    });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/target_provider 'azure-openai' is not a supported provider/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
  });

  it('refuses an array model_requested (editor would collapse it to a string)', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rule-9', team_id: 'team-1', name: 'Array matcher', priority: 100, enabled: true,
        condition: { model_requested: ['gpt-5.5', 'gpt-5.4'] },
        action: { type: 'route', target_provider: 'openai' },
      }),
    });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/model_requested arrays cannot be edited/i)).toBeDefined();
  });

  it('refuses malformed fallback chain entries', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rule-9', team_id: 'team-1', name: 'Bad fallback', priority: 100, enabled: true,
        condition: {},
        action: { type: 'route', target_provider: 'openai', fallback_chain: [{ provider: 'nope' }] },
      }),
    });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/fallback_chain entries must be/)).toBeDefined();
  });

  it('refuses editing a global (operator-managed) rule', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rule-global', team_id: '*', name: 'Global rule', priority: 10, enabled: true,
        condition: {},
        action: { type: 'route', target_provider: 'openai' },
      }),
    });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/Global rules are managed at the operator level/i)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
  });

  it('sends an explicit empty condition when the user clears every condition field', async () => {
    h.fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ROUTE_RULE });
    h.fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ updated: true }) });

    await act(async () => {
      render(<EditRulePage />);
    });

    await act(async () => {
      fireInput('Model Match', '');
      fireInput('Request Tags', '');
      fireInput('Max Input Tokens', '');
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });

    const patchCall = h.fetchMock.mock.calls.find(([url, init]) => url === '/api/rules/rule-9' && !!init);
    const body = JSON.parse(patchCall![1].body);
    // Merge-style PATCH: an explicit empty condition clears the stored one.
    expect(body.condition).toEqual({});
  });

  it('renders the proxy error message on failure (no object-as-React-child crash)', async () => {
    h.fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ROUTE_RULE });
    h.fetchMock.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({ error: { message: 'Proxy unavailable' } }) });

    await act(async () => {
      render(<EditRulePage />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    });

    expect(screen.getByText('Proxy unavailable')).toBeDefined();
  });

  it('refuses fallback entries with extra keys (lossy round-trip)', async () => {
    h.fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rule-9', team_id: 'team-1', name: 'Extra key fallback', priority: 100, enabled: true,
        condition: {},
        action: { type: 'route', target_provider: 'openai', fallback_chain: [{ provider: 'openai', model: 'gpt-5.5', weight: 2 }] },
      }),
    });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/fallback_chain entries must be/)).toBeDefined();
  });

  it('renders the 404 state for a missing rule', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });

    await act(async () => {
      render(<EditRulePage />);
    });

    expect(screen.getByText(/does not exist/i)).toBeDefined();
  });
});
