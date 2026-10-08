'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import Link from 'next/link';
import { readConsent, writeConsent } from '@/lib/analytics-consent';

export function CookieNotice() {
  const [show, setShow] = useState(false);
  const pathname = usePathname();
  const isDashboardRoute = pathname.startsWith('/overview') || pathname.startsWith('/savings') || pathname.startsWith('/usage') || pathname.startsWith('/tokens') || pathname.startsWith('/activity') || pathname.startsWith('/analytics') || pathname.startsWith('/yield') || pathname.startsWith('/optimize') || pathname.startsWith('/routing') || pathname.startsWith('/models') || pathname.startsWith('/keys') || pathname.startsWith('/billing') || pathname.startsWith('/settings');

  useEffect(() => {
    if (isDashboardRoute) {
      setShow(false);
      return;
    }
    if (!readConsent()) {
      setShow(true);
    }
  }, [isDashboardRoute]);

  const accept = () => {
    writeConsent('accepted');
    setShow(false);
  };

  const decline = () => {
    // Records an explicit opt-out; analytics providers read this and skip
    // initialisation (see lib/analytics-consent.ts).
    writeConsent('declined');
    setShow(false);
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          className={`fixed bottom-3 left-3 right-3 z-[100] mx-auto rounded-xl border border-white/[0.08] bg-zinc-900/90 p-3 shadow-2xl backdrop-blur-lg sm:left-6 sm:right-auto sm:max-w-lg sm:p-4 ${isDashboardRoute ? 'max-w-sm md:max-w-lg' : 'max-w-lg'}`}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <p className="text-xs leading-relaxed text-zinc-300 sm:text-sm">
                We use cookies to improve your experience and analyze our traffic.
                By continuing to use our site, you agree to our{' '}
                <Link href="/privacy" className="text-emerald-400 hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={decline}
                className="rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-all hover:bg-white/[0.08] hover:text-white sm:px-4 sm:py-2"
              >
                Decline
              </button>
              <button
                onClick={accept}
                className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition-all hover:bg-emerald-400 sm:px-4 sm:py-2"
              >
                Accept
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
