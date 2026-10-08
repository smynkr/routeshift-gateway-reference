"use client";

import { useEffect } from "react";
import { analyticsAllowed } from "@/lib/analytics-consent";

type IdleWin = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    // Respect an explicit cookie-notice opt-out before loading analytics.
    if (!analyticsAllowed()) return;
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
    if (!key || !host) {
      console.warn("PostHog disabled: NEXT_PUBLIC_POSTHOG_KEY and NEXT_PUBLIC_POSTHOG_HOST are required");
      return;
    }
    function init() {
      import("posthog-js").then(({ default: posthog }) => {
        posthog.init(key!, {
          api_host: host,
          ui_host: "https://us.posthog.com",
          defaults: "2026-01-30",
          person_profiles: "identified_only",
          capture_pageview: "history_change",
          capture_pageleave: true,
        });
      });
    }
    const w = window as IdleWin;
    const usingIdle = typeof w.requestIdleCallback === "function";
    const handle: number = usingIdle
      ? w.requestIdleCallback!(init, { timeout: 4000 })
      : window.setTimeout(init, 2000);
    return () => {
      if (usingIdle && typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(handle);
      } else {
        window.clearTimeout(handle);
      }
    };
  }, []);

  return <>{children}</>;
}
