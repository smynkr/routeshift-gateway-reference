# @routeshift/dashboard

Next.js 15 (App Router, React 19, Tailwind 4) web UI: public product surface (`/`,
`/models`, `/rankings`, `/compare/openrouter`, `/security`, `/changelog`) plus the
authenticated workspace (`/overview`, `/savings`, `/usage`, `/tokens`, `/activity`,
`/analytics`, `/yield`, `/optimize`, `/routing`, `/presets`, `/shadow-experiments`,
`/plugins`, `/models`, `/keys`, `/billing`, `/settings`). Run it against a local or
self-hosted gateway.

The dashboard defaults to `http://localhost:3000`; snippets and health links use
`NEXT_PUBLIC_PROXY_URL` (default `http://localhost:4000`). Set `NEXT_PUBLIC_APP_URL`
and `NEXT_PUBLIC_PROXY_URL` for your own origins. Analytics is opt-in: Google
Analytics needs `NEXT_PUBLIC_GA_MEASUREMENT_ID`, and PostHog needs both
`NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`.

## Commands

```bash
pnpm --filter @routeshift/shared build   # required first: shared resolves dist/
pnpm --filter @routeshift/dashboard dev
pnpm --filter @routeshift/dashboard typecheck
pnpm --filter @routeshift/dashboard test
pnpm --filter @routeshift/dashboard build
pnpm --filter @routeshift/dashboard seed:demo    # seed the demo team
pnpm --filter @routeshift/dashboard demo:health  # verify demo dataset
```

## Conventions

- **No fake metrics.** Costs, latency, and provider data come from live proxy data or fixtures explicitly labeled as fixtures/sample (`LANDING_DASHBOARD_PREVIEW_SAMPLE`, demo dataset). Never present sample numbers as telemetry.
- **Demo isolation.** Team-scoped reads go through `getEffectiveTeamId()` (fixed demo-team substitution); writes refuse with 403 when demo mode is active.
- **Exact reasons.** Skip/fallback/error codes render verbatim from proxy to log to UI — no vague buckets.
- **Styling.** Tailwind utilities + CSS vars in `app/globals.css`; no parallel token layer. DM Sans UI, JetBrains Mono code, Instrument Serif for marketing display type. New interactions target WCAG 2.2 AA.
- **Server vs client.** Overview/savings/usage/yield read Postgres directly in server components; analytics/billing/optimize fetch `/api/*` in client components. New sections should follow one of the two, not mix.
- **Public routes** must be allowlisted in `middleware.ts` (prefix list + matcher) or they 307 to `/login`; add them to `app/sitemap.ts` and both footers (`app/landing-client.tsx` + `components/marketing/marketing-footer.tsx`, parity pinned by `tests/landing-page-polish.test.tsx`).
- **Per-route OG images** live next to their page (`opengraph-image.tsx`); the root one is the fallback.
