import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_KEY, CONSENT_CHANGE_EVENT } from '@/lib/analytics-consent';

// RSH-59: Sentry session replay must honor analytics consent. instrumentation-
// client.ts ran Sentry.init() with replayIntegration + replaysSessionSampleRate
// 0.1 unconditionally, recording ~10% of sessions for users who clicked Decline.

const sentry = vi.hoisted(() => {
  const replay = { stop: vi.fn() };
  return {
    init: vi.fn(),
    replayIntegration: vi.fn(() => ({ name: 'Replay' })),
    captureConsoleIntegration: vi.fn(() => ({ name: 'CaptureConsole' })),
    captureRouterTransitionStart: vi.fn(),
    getReplay: vi.fn(() => replay),
    _replay: replay,
  };
});
vi.mock('@sentry/nextjs', () => sentry);

let consent: string | null = null;
let addEventListenerSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  sentry.init.mockClear();
  sentry.replayIntegration.mockClear();
  sentry.getReplay.mockClear();
  sentry._replay.stop.mockClear();
  consent = null;
  addEventListenerSpy = vi.fn();
  vi.stubGlobal('window', {
    localStorage: { getItem: (k: string) => (k === CONSENT_KEY ? consent : null), setItem: vi.fn() },
    addEventListener: addEventListenerSpy,
    dispatchEvent: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sentry session replay consent gate (RSH-59)', () => {
  it('disables session replay when the user has declined', async () => {
    consent = 'declined';
    await import('@/instrumentation-client');

    expect(sentry.init).toHaveBeenCalledTimes(1);
    const cfg = sentry.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(cfg.replaysSessionSampleRate).toBe(0);
    expect(cfg.replaysOnErrorSampleRate).toBe(0);
    expect(sentry.replayIntegration).not.toHaveBeenCalled();
  });

  it('keeps session replay when consent is not declined (implied/opt-out)', async () => {
    consent = null;
    await import('@/instrumentation-client');

    const cfg = sentry.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(cfg.replaysSessionSampleRate as number).toBeGreaterThan(0);
    expect(sentry.replayIntegration).toHaveBeenCalled();
  });

  it('stops in-progress replay when the user declines mid-session', async () => {
    consent = null; // replay running at init
    await import('@/instrumentation-client');

    const entry = addEventListenerSpy.mock.calls.find(([ev]) => ev === CONSENT_CHANGE_EVENT);
    expect(entry).toBeDefined();
    const handler = entry![1] as () => void;

    consent = 'declined';
    handler();

    expect(sentry.getReplay).toHaveBeenCalled();
    expect(sentry._replay.stop).toHaveBeenCalled();
  });
});
