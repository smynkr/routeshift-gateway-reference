'use client';

import { CompareTemplate } from '../compare-template';

export default function PortkeyComparePage() {
  return (
    <CompareTemplate
      competitorName="Portkey"
      pagePath="/compare/portkey"
      heroSubtitle="Both platforms promise visibility and control over production AI. The difference is the proof — enterprise governance breadth versus policy routing with receipts for every saved dollar."
      competitorPricing={{
        subtitle: 'Gateway-plus-observability pricing — verify current terms below',
        items: [
          { label: 'Gateway path', value: 'Provider spend plus gateway terms — verify current pricing' },
          { label: 'Observability path', value: 'Usage-based logging tiers — verify current pricing' },
          { label: 'Enterprise path', value: 'Custom enterprise terms — verify with Portkey' },
        ],
      }}
      differentiator={{
        competitorTitle: "Portkey's value follows governed production scale",
        competitorBody:
          'Portkey packages gateway routing with guardrails, provider management, and reporting aimed at production teams. Named customer outcomes emphasize fast integration, central logs, and cost visibility — confirm which plan carries each control.',
        routeshiftTitle: "RouteShift's BYOK fee tracks your savings",
        routeshiftBody:
          "In BYOK mode, our savings share only applies when we actually reduce your costs. If routing doesn't save you anything, you pay zero — no platform fee, no savings share. The BYOK savings-share fee grows only when measured savings grow.",
        footnote:
          'In RouteShift BYOK mode, zero measured optimization means a $0 savings share and provider spend still has 0% markup. Managed credits are a separate mode and include the plan\u2019s credits markup.',
      }}
      verifyPrefix="Portkey comparison terms can change over time. Verify current details on the"
      verifyLinks={[{ label: 'Portkey site', href: 'https://portkey.ai' }]}
      closingLine="Portkey excels at governed production breadth. RouteShift excels at cost optimization. Both are solid choices — it depends on what matters most to your team."
      rows={[
        {
          category: 'Pricing',
          items: [
            {
              feature: 'Pricing model',
              routeshift: '0% BYOK spend markup + 3% of measured savings',
              competitor: 'Gateway plus observability tiers; custom enterprise terms — verify current pricing',
              winner: 'tie',
            },
            {
              feature: 'Fee when not optimizing',
              routeshift: 'BYOK: $0 share at $0 savings; credits still add 3%',
              competitor: 'Platform metering applies to routed volume',
              winner: 'tie',
            },
            {
              feature: 'Incentive alignment',
              routeshift: 'BYOK share tracks savings; credits markup tracks usage',
              competitor: 'Value tracks governed coverage, not your savings outcome',
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
              competitor: 'Gateway routing with load balancing and conditional fallbacks',
              winner: 'tie',
            },
            {
              feature: 'Fallback chains',
              routeshift: 'Ordered models[] chains across providers with exact per-attempt outcomes logged',
              competitor: 'Conditional fallback routing across providers',
              winner: 'tie',
            },
            {
              feature: 'Response caching',
              routeshift: 'Narrower eligibility (temperature=0 only; no streaming or tools) — bills the cache hit at full cost',
              competitor: 'Semantic and exact caching with reported savings — verify current eligibility',
              winner: 'tie',
            },
            {
              feature: 'Guardrails',
              routeshift: 'Prompt guardrails and data-policy requirements run as pre-dispatch checks when configured',
              competitor: 'Mature guardrail suite positioned for production governance',
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
              competitor: 'Broad virtual-key provider management across major providers',
              winner: 'tie',
            },
            {
              feature: 'Enterprise proof',
              routeshift: 'Evidence-first claims only — no customer logos without permission',
              competitor: 'Named customer outcomes and production-scale positioning',
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
              competitor: 'Central logs with cost visibility valued in customer outcomes',
              winner: 'tie',
            },
            {
              feature: 'Savings tracking',
              routeshift: 'Original vs actual cost on every request, with savings receipts',
              competitor: 'Caching-savings surface — verify whether routing savings are receipted',
              winner: 'routeshift',
            },
            {
              feature: 'Failure diagnosis',
              routeshift: 'Exact skip/fallback/error reasons preserved verbatim into Activity',
              competitor: 'Centralized logs positioned to pinpoint downtime and unexpected outputs',
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
              competitor: 'Budget and limit controls — verify enforcement semantics',
              winner: 'routeshift',
            },
            {
              feature: 'Access control',
              routeshift: 'Role-based access, scoped keys, and per-key audit events',
              competitor: 'Team workspaces with enterprise access controls',
              winner: 'tie',
            },
          ],
        },
      ]}
      useCompetitorWhen={{
        subtitle: 'You need governed production breadth',
        bullets: [
          'You need a mature guardrail suite with enterprise rollout patterns',
          'Your procurement values named customer proof and custom enterprise terms',
          'You manage many provider keys centrally with virtual-key workflows',
          'Governance breadth matters more than per-request savings receipts',
        ],
      }}
      migration={{
        baseUrl: 'https://api.portkey.ai/v1',
        keyLabel: 'Portkey key via x-portkey-api-key header',
        modelLabel: 'model: OpenAI-style ids per Portkey docs',
        note: 'Portkey routes per-provider with virtual keys and headers — confirm your mapping, then confirm model ids on the',
      }}
      switchingHeading="Switching from Portkey takes minutes"
      switchingIntro="Both APIs speak the OpenAI chat-completions shape, so the migration is a base-URL swap plus a key exchange. Reproduce your fallback order as a RouteShift models[] chain and verify the first decisions in Activity before moving production traffic."
    />
  );
}
