import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@routeshift/shared"],
  async headers() {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      // GA origins: gtag.js script (script-src) + GA4 collectors
      // (www.google-analytics.com + regional subdomains). Deliberately NOT
      // added: analytics.google.com / stats.g.doubleclick.net (Google
      // Signals + ads personalization are off on the GA property; if they
      // are ever enabled, those beacon origins must be added here).
      "connect-src 'self' https://*.sentry.io https://us.posthog.com https://*.posthog.com https://*.i.posthog.com https://api2.amplitude.com https://*.amplitude.com https://api-js.mixpanel.com https://api.mixpanel.com https://*.mixpanel.com https://www.google-analytics.com https://*.google-analytics.com wss:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
    ].join('; ');

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          // preload omitted until all subdomains are verified HTTPS-only
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'Content-Security-Policy', value: csp },
        ],
      },
    ];
  }
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  disableLogger: true,
  automaticVercelMonitors: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
});
