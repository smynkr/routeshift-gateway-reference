import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'RouteShift vs Portkey — Pricing & Feature Comparison',
  description:
    'Compare RouteShift and Portkey side-by-side, including usage fees, routing, guardrails, caching, and production governance.',
  keywords: [
    'RouteShift vs Portkey',
    'Portkey alternative',
    'LLM proxy comparison',
    'cheapest LLM proxy',
    'AI API gateway comparison',
    'LLM cost optimization comparison',
    'Portkey pricing',
  ],
};

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
