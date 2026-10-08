import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'RouteShift vs Helicone — Pricing & Feature Comparison',
  description:
    'Compare RouteShift and Helicone side-by-side, including usage fees, routing, observability depth, caching, and prompt workflows.',
  keywords: [
    'RouteShift vs Helicone',
    'Helicone alternative',
    'LLM proxy comparison',
    'cheapest LLM proxy',
    'AI API gateway comparison',
    'LLM cost optimization comparison',
    'Helicone pricing',
  ],
};

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
