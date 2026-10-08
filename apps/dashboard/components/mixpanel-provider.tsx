"use client";

import { useEffect, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import mixpanel from "mixpanel-browser";
import { analyticsAllowed, readConsent, CONSENT_CHANGE_EVENT } from "@/lib/analytics-consent";

const REPLAY_ENABLED = process.env.NEXT_PUBLIC_MIXPANEL_SESSION_REPLAY === "true";

let mixpanelReady = false;

// RSH-51: init is deferred to a post-mount idle callback (below) rather than
// running at module-load. Even under the opt-out model, firing Mixpanel +
// session replay synchronously on import meant it ran *before* the cookie
// notice had rendered. Deferring it brings Mixpanel in line with the PostHog
// and Amplitude providers (idle/2s after mount) so the notice is on screen
// first, and a decline registered in that window is honoured before init.
function initMixpanel(): void {
  if (mixpanelReady) return;
  if (typeof window === "undefined" || process.env.NODE_ENV !== "production") return;
  // Skip init entirely when the user has explicitly opted out via the notice.
  if (!analyticsAllowed()) return;
  const token = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;
  if (!token) return;
  mixpanel.init(token, {
    debug: false,
    track_pageview: false,
    persistence: "localStorage",
    ignore_dnt: false,
    record_sessions_percent: REPLAY_ENABLED ? 100 : 0,
    record_mask_all_text: true,
    record_mask_all_inputs: true,
    record_block_selector: "img, video",
    record_idle_timeout_ms: 1_800_000,
    record_min_ms: 0,
  });
  mixpanelReady = true;
  if (REPLAY_ENABLED) {
    try {
      const recorder = mixpanel as unknown as { start_session_recording?: () => void };
      recorder.start_session_recording?.();
    } catch (err) {
      console.warn("[mixpanel] start_session_recording failed", err);
    }
  }
}

function MixpanelPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!mixpanelReady || !pathname) return;
    let url = window.location.origin + pathname;
    if (searchParams.toString()) url += `?${searchParams.toString()}`;
    mixpanel.track("$mp_web_page_view", {
      $current_url: url,
      page_path: pathname,
    });
  }, [pathname, searchParams]);

  return null;
}

export function MixpanelProvider({ children }: { children: React.ReactNode }) {
  // Defer init until the browser is idle (or 2s), after the cookie notice has
  // mounted — matching amplitude-provider / posthog-provider.
  useEffect(() => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === "function") {
      // Pass a timeout (like amplitude/posthog) so a continuously busy page —
      // where idle never arrives — still initialises within a bounded delay
      // instead of never firing.
      const id = w.requestIdleCallback(initMixpanel, { timeout: 4000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const timer = setTimeout(initMixpanel, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Honour a mid-session Decline immediately. Mixpanel runs session replay at
  // 100% when enabled, so simply not initialising next time isn't enough — stop
  // tracking + recording the instant the user opts out.
  useEffect(() => {
    function onConsentChange() {
      if (readConsent() !== "declined") return;
      try {
        const m = mixpanel as unknown as {
          opt_out_tracking?: () => void;
          stop_session_recording?: () => void;
        };
        m.opt_out_tracking?.();
        m.stop_session_recording?.();
      } catch {
        // mixpanel may be uninitialised (declined before load) — nothing to stop.
      }
    }
    window.addEventListener(CONSENT_CHANGE_EVENT, onConsentChange);
    return () => window.removeEventListener(CONSENT_CHANGE_EVENT, onConsentChange);
  }, []);

  return (
    <>
      <Suspense>
        <MixpanelPageView />
      </Suspense>
      {children}
    </>
  );
}
