"use client";

import { useEffect } from "react";
import { analyticsAllowed } from "@/lib/analytics-consent";

type IdleWin = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function AmplitudeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    // Respect an explicit cookie-notice opt-out before loading analytics +
    // session replay (Amplitude session replay samples at 100% here).
    if (!analyticsAllowed()) return;
    const key = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY;
    if (!key) return;
    function init() {
      import("@amplitude/unified").then((amplitude) => {
        amplitude.initAll(key!, {
          analytics: { autocapture: true },
          sessionReplay: { sampleRate: 1 },
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
