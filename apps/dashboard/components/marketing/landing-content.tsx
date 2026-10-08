import { LandingCta } from '@/components/marketing/landing-cta';
import { LandingFaq, LANDING_FAQ_ITEMS } from '@/components/marketing/landing-faq';
import { LandingHero } from '@/components/marketing/landing-hero';
import { MarketingFooter } from '@/components/marketing/marketing-footer';
import { MarketingNav } from '@/components/marketing/marketing-nav';
import { PricingProof } from '@/components/marketing/pricing-proof';
import { ProductProof } from '@/components/marketing/product-proof';
import { UseCases } from '@/components/marketing/use-cases';
import { ProofPillars } from '@/components/marketing/proof-pillars';
import { ProviderCompatibility } from '@/components/marketing/provider-compatibility';
import { IntegrationProof } from '@/components/marketing/integration-proof';
import { SetupPath } from '@/components/marketing/setup-path';
import { Quickstart } from '@/components/marketing/quickstart';
import { TrustEvidence } from '@/components/marketing/trust-evidence';
import { Reveal } from '@/components/marketing/reveal';
import { PUBLIC_APP_BASE_URL } from '@/lib/public-urls';

const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      name: 'RouteShift',
      url: PUBLIC_APP_BASE_URL,
      description: 'Explainable policy routing for OpenAI-compatible AI requests, with budgets, data-policy controls, and measured savings evidence.',
    },
    {
      '@type': 'SoftwareApplication',
      name: 'RouteShift',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Web',
      description: 'Control where AI requests run with routing, budget, quality, and data-policy rules—then inspect the exact route and measured savings.',
      featureList: [
        'Policy routing with exact decision reasons',
        'Budget, allowlist, guardrail, and data-policy controls',
        'OpenAI-compatible endpoint',
        'Measured savings evidence',
        'MCP catalog and typed SDK',
      ],
      offers: [
        {
          '@type': 'Offer',
          name: 'Active-plan BYOK',
          description: '$0 monthly platform fee + 3% of positive measured savings',
        },
        {
          '@type': 'Offer',
          name: 'Free BYOK',
          price: '0',
          priceCurrency: 'USD',
          description: '$0 monthly platform fee + 0% provider-spend markup + 0% savings share',
        },
        {
          '@type': 'Offer',
          name: 'Active credits',
          description: 'Provider-plus-plugin cost + 3% credits markup',
        },
      ],
    },
    {
      '@type': 'FAQPage',
      mainEntity: LANDING_FAQ_ITEMS.map((item) => ({
        '@type': 'Question',
        name: item.question,
        acceptedAnswer: {
          '@type': 'Answer',
          text: item.answer,
        },
      })),
    },
  ],
};

export function LandingContent() {
  return (
    <div className="min-h-screen bg-[#09090b] text-white">
      <MarketingNav />
      <main>
        <LandingHero />
        <Reveal><ProviderCompatibility /></Reveal>
        <Reveal><ProofPillars /></Reveal>
        <Reveal><IntegrationProof /></Reveal>
        <Reveal><ProductProof /></Reveal>
        <Reveal><UseCases /></Reveal>
        <Reveal><SetupPath /></Reveal>
        <Reveal><Quickstart /></Reveal>
        <Reveal><PricingProof /></Reveal>
        <Reveal><TrustEvidence /></Reveal>
        <Reveal><LandingFaq /></Reveal>
        <Reveal><LandingCta /></Reveal>
      </main>
      <MarketingFooter />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
    </div>
  );
}
