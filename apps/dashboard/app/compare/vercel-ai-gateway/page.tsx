'use client';

import { CompareTemplate } from '../compare-template';

export default function VercelAiGatewayComparePage() {
  return (
    <CompareTemplate
      competitorName="Vercel AI Gateway"
      pagePath="/compare/vercel-ai-gateway"
      heroSubtitle="Both platforms put many models behind one API key. The difference is what happens after the request — framework-native velocity versus policy routing with measured savings."
      competitorPricing={{
        subtitle: 'Hero positioning observed 2026-08-26 — verify current terms below',
        items: [
          { label: 'Hero positioning', value: 'Hundreds of models, one API key' },
          { label: 'Markup claim', value: 'No-markup hero claim — verify current terms' },
          { label: 'Managed usage', value: 'Vercel-billed usage — verify current pricing' },
        ],
      }}
      differentiator={{
        competitorTitle: "Vercel's costs follow Vercel billing",
        competitorBody:
          'Vercel AI Gateway is priced and billed through Vercel. Model availability, modalities, and task surfaces move with the Vercel platform — confirm what applies to your workspace before comparing totals.',
        routeshiftTitle: "RouteShift's BYOK fee tracks your savings",
        routeshiftBody:
          "In BYOK mode, our savings share only applies when we actually reduce your costs. If routing doesn't save you anything, you pay zero — no platform fee, no savings share. The BYOK savings-share fee grows only when measured savings grow.",
        footnote:
          'In RouteShift BYOK mode, zero measured optimization means a $0 savings share and provider spend still has 0% markup. Managed credits are a separate mode and include the plan\u2019s credits markup.',
      }}
      verifyPrefix="Vercel comparison terms can change over time. Verify current details in the"
      verifyLinks={[{ label: 'Vercel AI Gateway page', href: 'https://vercel.com/ai-gateway' }]}
      closingLine="Vercel excels at framework-native breadth. RouteShift excels at cost optimization. Both are solid choices — it depends on what matters most to your team."
      rows={[
        {
          category: 'Pricing',
          items: [
            {
              feature: 'Pricing model',
              routeshift: '0% BYOK spend markup + 3% of measured savings',
              competitor: 'Vercel-billed gateway usage — verify current pricing',
              winner: 'tie',
            },
            {
              feature: 'Fee when not optimizing',
              routeshift: 'BYOK: $0 share at $0 savings; credits still add 3%',
              competitor: 'Usage billed through Vercel regardless of optimization outcome',
              winner: 'tie',
            },
            {
              feature: 'Incentive alignment',
              routeshift: 'BYOK share tracks savings; credits markup tracks usage',
              competitor: 'Gateway fee tracks platform usage, not your savings outcome',
              winner: 'routeshift',
            },
          ],
        },
        {
          category: 'Routing & Optimization',
          items: [
            {
              feature: 'Smart routing engine',
              routeshift: 'Rules with conditions and priorities, plus auto-routing strategies (cheapest/fastest/balanced), versioned presets with history, and response quality gates',
              competitor: 'Provider routing with task-tabbed integration surfaces',
              winner: 'tie',
            },
            {
              feature: 'Agent setup surfaces',
              routeshift: 'Connect CLI for opencode, Continue/Cline, aider plus guided Cursor setup, and a read-only MCP catalog',
              competitor: 'Task tabs for API, Claude Code, Codex, Hermes, OpenCode, OpenClaw plus Copy for agent',
              winner: 'competitor',
            },
            {
              feature: 'Fallback chains',
              routeshift: 'Ordered models[] chains across providers with exact per-attempt outcomes logged',
              competitor: 'Provider fallback available',
              winner: 'tie',
            },
            {
              feature: 'Response caching',
              routeshift: 'Narrower eligibility (temperature=0 only; no streaming or tools) — bills the cache hit at full cost',
              competitor: 'Caching available — verify current eligibility and billing semantics',
              winner: 'tie',
            },
          ],
        },
        {
          category: 'Models & Providers',
          items: [
            {
              feature: 'Model breadth',
              routeshift: 'Curated public model registry optimized for cost-quality tradeoffs',
              competitor: 'Hundreds-of-models hero positioning with broad modality coverage — verify current catalog',
              winner: 'competitor',
            },
            {
              feature: 'Framework fit',
              routeshift: 'OpenAI-compatible endpoint any client or SDK can adopt with a base-URL swap',
              competitor: 'First-class Vercel AI SDK and Vercel platform fit',
              winner: 'competitor',
            },
          ],
        },
        {
          category: 'Analytics & Visibility',
          items: [
            {
              feature: 'Cost analytics',
              routeshift: 'Per-model, per-provider, daily trends + LLM classifier that tags sampled, PII-stripped requests across custom dimensions',
              competitor: 'Vercel-native usage views — verify current analytics scope',
              winner: 'tie',
            },
            {
              feature: 'Savings tracking',
              routeshift: 'Original vs actual cost on every request, with savings receipts',
              competitor: 'No measured-savings receipt surface — verify current offering',
              winner: 'routeshift',
            },
            {
              feature: 'Route explanations',
              routeshift: 'Matched rule, resolved route, fallback chain, and exact skip/fallback reasons preserved verbatim',
              competitor: 'Routing operates inside the Vercel platform surface',
              winner: 'routeshift',
            },
          ],
        },
        {
          category: 'Control & Governance',
          items: [
            {
              feature: 'Budget enforcement',
              routeshift: 'Daily, weekly, and monthly budget windows at team, person, and key scope with fail-closed admission',
              competitor: 'Spend controls follow Vercel workspace controls — verify current scope',
              winner: 'routeshift',
            },
            {
              feature: 'Data-policy controls',
              routeshift: 'Provider/model allowlists, prompt guardrails, residency and ZDR policy as pre-dispatch checks',
              competitor: 'Platform trust surface — verify current controls',
              winner: 'tie',
            },
          ],
        },
      ]}
      useCompetitorWhen={{
        subtitle: 'You ship inside the Vercel platform',
        bullets: [
          'You build with the Vercel AI SDK and want the gateway beside your deployment',
          'You want task-tabbed snippets and Copy-for-agent harness setup',
          'You need broad modality coverage in one gateway — verify current support',
          'You prefer Vercel-native billing and observability over a separate control plane',
        ],
      }}
      migration={{
        baseUrl: 'https://ai-gateway.vercel.sh/v1',
        keyLabel: 'Vercel gateway key (see Vercel docs)',
        modelLabel: 'model: provider/model ids per Vercel docs',
        note: 'Model ids differ between catalogs — confirm yours on the',
      }}
      switchingHeading="Switching from Vercel AI Gateway takes minutes"
      switchingIntro="Both APIs speak the OpenAI chat-completions shape, so the migration is a base-URL swap plus a key exchange. Confirm the documented gateway base URL and your model ids before moving production traffic."
    />
  );
}
