'use client';

import { CompareTemplate } from '../compare-template';

export default function HeliconeComparePage() {
  return (
    <CompareTemplate
      competitorName="Helicone"
      pagePath="/compare/helicone"
      heroSubtitle="Both platforms sit in front of your providers and record what happened. The difference is emphasis — mature observability workflows versus enforced policy with measured savings."
      competitorPricing={{
        subtitle: 'Observability-plus-gateway pricing — verify current terms below',
        items: [
          { label: 'Observability path', value: 'Usage-based logging tiers — verify current pricing' },
          { label: 'Gateway path', value: 'Provider spend plus gateway terms — verify current pricing' },
          { label: 'Caching benefit', value: 'Cache savings surface — verify current semantics' },
        ],
      }}
      differentiator={{
        competitorTitle: "Helicone's value compounds with logged volume",
        competitorBody:
          'Helicone turns request volume into traces, sessions, prompts, and experiments. Its value grows the more traffic you route through it — confirm which tiers and retention terms apply to your workspace.',
        routeshiftTitle: "RouteShift's BYOK fee tracks your savings",
        routeshiftBody:
          "In BYOK mode, our savings share only applies when we actually reduce your costs. If routing doesn't save you anything, you pay zero — no platform fee, no savings share. The BYOK savings-share fee grows only when measured savings grow.",
        footnote:
          'In RouteShift BYOK mode, zero measured optimization means a $0 savings share and provider spend still has 0% markup. Managed credits are a separate mode and include the plan\u2019s credits markup.',
      }}
      verifyPrefix="Helicone comparison terms can change over time. Verify current details on the"
      verifyLinks={[{ label: 'Helicone site', href: 'https://www.helicone.ai' }]}
      closingLine="Helicone excels at observability depth. RouteShift excels at cost optimization. Both are solid choices — it depends on what matters most to your team."
      rows={[
        {
          category: 'Pricing',
          items: [
            {
              feature: 'Pricing model',
              routeshift: '0% BYOK spend markup + 3% of measured savings',
              competitor: 'Usage-based observability plus gateway terms — verify current pricing',
              winner: 'tie',
            },
            {
              feature: 'Fee when not optimizing',
              routeshift: 'BYOK: $0 share at $0 savings; credits still add 3%',
              competitor: 'Logging and gateway metering apply to routed volume',
              winner: 'tie',
            },
            {
              feature: 'Incentive alignment',
              routeshift: 'BYOK share tracks savings; credits markup tracks usage',
              competitor: 'Value tracks observability coverage, not your savings outcome',
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
              competitor: 'Gateway routing with provider fallback options',
              winner: 'tie',
            },
            {
              feature: 'Fallback chains',
              routeshift: 'Ordered models[] chains across providers with exact per-attempt outcomes logged',
              competitor: 'Fallback support available',
              winner: 'tie',
            },
            {
              feature: 'Response caching',
              routeshift: 'Narrower eligibility (temperature=0 only; no streaming or tools) — bills the cache hit at full cost',
              competitor: 'Cache layer with savings reporting — verify current eligibility',
              winner: 'tie',
            },
            {
              feature: 'Prompt workflows',
              routeshift: 'Policy presets pin model, params, system prompt, and provider preferences per key',
              competitor: 'Mature prompt versioning, experiments, and session traces',
              winner: 'competitor',
            },
          ],
        },
        {
          category: 'Models & Providers',
          items: [
            {
              feature: 'Provider posture',
              routeshift: 'Curated public model registry optimized for cost-quality tradeoffs',
              competitor: 'Provider-agnostic proxy posture across major providers',
              winner: 'tie',
            },
            {
              feature: 'Integration shape',
              routeshift: 'OpenAI-compatible endpoint any client or SDK can adopt with a base-URL swap',
              competitor: 'Proxy base-URL swap with per-provider header routing',
              winner: 'tie',
            },
          ],
        },
        {
          category: 'Analytics & Visibility',
          items: [
            {
              feature: 'Observability depth',
              routeshift: 'Per-model, per-provider, daily trends with Activity-level request inspection',
              competitor: 'Deep traces, sessions, and custom properties with the product preview directly below the hero',
              winner: 'competitor',
            },
            {
              feature: 'Savings tracking',
              routeshift: 'Original vs actual cost on every request, with savings receipts',
              competitor: 'Cache-savings surface — verify whether routing savings are receipted',
              winner: 'routeshift',
            },
            {
              feature: 'Route explanations',
              routeshift: 'Matched rule, resolved route, fallback chain, and exact skip/fallback reasons preserved verbatim',
              competitor: 'Request-level traces show provider path and errors',
              winner: 'tie',
            },
          ],
        },
        {
          category: 'Control & Governance',
          items: [
            {
              feature: 'Budget enforcement',
              routeshift: 'Daily, weekly, and monthly budget windows at team, person, and key scope with fail-closed admission',
              competitor: 'Alerts and limits surface — verify enforcement semantics',
              winner: 'routeshift',
            },
            {
              feature: 'Team controls',
              routeshift: 'Role-based access, scoped keys, and per-key audit events',
              competitor: 'Team workspaces with organization controls',
              winner: 'tie',
            },
          ],
        },
      ]}
      useCompetitorWhen={{
        subtitle: 'Observability is the job',
        bullets: [
          'You want traces, sessions, and prompt versions as the primary surface',
          'You run prompt experiments and need mature evaluation workflows',
          'Your team already standardizes on Helicone dashboards and alerts',
          'Logging retention and custom properties matter more than routing policy',
        ],
      }}
      migration={{
        baseUrl: 'https://oai.helicone.ai/v1',
        keyLabel: 'Helicone key via x-helicone-api-key header',
        modelLabel: 'model: OpenAI-style ids per Helicone docs',
        note: 'Helicone routes per-provider by base URL and headers — confirm your mapping, then confirm model ids on the',
      }}
      switchingHeading="Switching from Helicone takes minutes"
      switchingIntro="Both APIs speak the OpenAI chat-completions shape, so the migration is a base-URL swap plus a key exchange. Keep your Helicone instrumentation in place during the transition and compare receipts before cutting over."
    />
  );
}
