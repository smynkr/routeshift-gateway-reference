import * as Sentry from "@sentry/nextjs";
import { analyticsAllowed, readConsent, CONSENT_CHANGE_EVENT } from "@/lib/analytics-consent";

// RSH-59: session replay is exactly the "session-replay" the consent module
// promises to suppress on decline (lib/analytics-consent.ts). Gate it on consent
// rather than recording ~10% of declined users' sessions. Evaluated at module
// load on the client, mirroring how the other analytics providers gate.
const replayAllowed = analyticsAllowed();

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,
  replaysSessionSampleRate: replayAllowed ? 0.1 : 0,
  replaysOnErrorSampleRate: replayAllowed ? 1.0 : 0,
  enableLogs: true,
  integrations: [
    ...(replayAllowed ? [Sentry.replayIntegration()] : []),
    Sentry.captureConsoleIntegration({ levels: ["error", "warn"] }),
  ],
});

// If the user declines mid-session, stop any in-progress replay (mirrors the
// mid-session handling the other providers already do, e.g. mixpanel-provider).
// getReplay is accessed defensively: it is part of the browser replay API but is
// not always surfaced in @sentry/nextjs's re-exported types.
if (typeof window !== "undefined") {
  window.addEventListener(CONSENT_CHANGE_EVENT, () => {
    if (readConsent() === "declined") {
      const replay = (Sentry as { getReplay?: () => { stop?: () => unknown } | undefined }).getReplay?.();
      void replay?.stop?.();
    }
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
