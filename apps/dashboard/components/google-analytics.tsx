'use client';

import { useEffect, useState } from 'react';
import Script from 'next/script';
import { analyticsAllowed, CONSENT_CHANGE_EVENT } from '@/lib/analytics-consent';

/**
 * Google Analytics, gated on cookie consent. Renders nothing on the server and
 * until consent is resolved on the client, so a user who declines in the cookie
 * notice never loads gtag. Listens for consent changes so accepting starts GA
 * without a reload.
 */
export function GoogleAnalytics({ measurementId }: { measurementId: string }) {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    const update = () => setAllowed(analyticsAllowed());
    update();
    window.addEventListener(CONSENT_CHANGE_EVENT, update);
    return () => window.removeEventListener(CONSENT_CHANGE_EVENT, update);
  }, []);

  if (!allowed) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`}
        strategy="afterInteractive"
      />
      <Script id="gtag-init" strategy="afterInteractive">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${measurementId}');`}
      </Script>
    </>
  );
}
