export interface ProductRelease {
  slug: string;
  date: string;
  title: string;
  summary: string;
  highlights: readonly string[];
  cta?: { href: string; label: string };
}

export const PRODUCT_RELEASES = [
  {
    slug: 'proof-first-product-polish',
    date: '2026-09-03',
    title: 'Proof-first product story',
    summary: 'The public landing now leads with an explainable routing decision and measured-savings evidence, and the dashboard groups operator routes by job with linkable analytics evidence.',
    highlights: ['Interactive route-decision trace with copyable explanations', 'Decide, Protect, and Prove pillars with a worked pricing example', 'Job-grouped navigation plus analytics drill-through into Activity'],
    cta: { href: '/', label: 'Explore RouteShift' },
  },
  {
    slug: 'public-product-and-accessibility-refresh',
    date: '2026-08-11',
    title: 'A clearer, more accessible RouteShift',
    summary: 'The public product story now reflects shipped policy controls and agent tooling with a full public-surface accessibility pass.',
    highlights: ['Budget windows and policy presets in the product story', 'Agent tooling and MCP catalog guidance', 'WCAG label, contrast, and heading corrections'],
    cta: { href: '/', label: 'Explore RouteShift' },
  },
  {
    slug: 'savings-proof-and-routing-tools',
    date: '2026-08-09',
    title: 'Savings proof and routing tools',
    summary: 'New tools make routing policy and measured savings easier to inspect before and after traffic runs.',
    highlights: ['Savings simulator and monthly receipt', 'Browser-only routing playground', 'Cost anomaly alerts and rule templates'],
  },
  {
    slug: 'shadow-experiments',
    date: '2026-08-05',
    title: 'Shadow experiment controls',
    summary: 'Configure and review shadow-experiment definitions from the dashboard while execution remains disabled pending the approved consent workflow.',
    highlights: ['Team-scoped configuration', 'Truthful killed/quarantined/disabled states', 'Enablement remains fail-closed'],
  },
  {
    slug: 'explainable-routing-controls',
    date: '2026-08-04',
    title: 'Explainable routing and operator controls',
    summary: 'RouteShift deepened model discovery, policy controls, loading states, and exact request-level explanations.',
    highlights: ['Auth-aware model catalog', 'Quality and data-policy controls', 'Request audit and empty-state improvements'],
  },
] as const satisfies readonly ProductRelease[];
