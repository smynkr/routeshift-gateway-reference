import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'RouteShift vs OpenRouter — Pricing & Feature Comparison',
  description:
    'Compare RouteShift and OpenRouter side-by-side, including BYOK fees, managed-credit fees, routing, caching, and model breadth.',
  keywords: [
    'RouteShift vs OpenRouter',
    'OpenRouter alternative',
    'LLM proxy comparison',
    'cheapest LLM proxy',
    'AI API gateway comparison',
    'LLM cost optimization comparison',
    'OpenRouter pricing',
  ],
};

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
