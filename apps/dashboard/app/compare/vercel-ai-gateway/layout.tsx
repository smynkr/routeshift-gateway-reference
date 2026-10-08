import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'RouteShift vs Vercel AI Gateway — Pricing & Feature Comparison',
  description:
    'Compare RouteShift and Vercel AI Gateway side-by-side, including usage fees, routing, agent setup surfaces, caching, and model breadth.',
  keywords: [
    'RouteShift vs Vercel AI Gateway',
    'Vercel AI Gateway alternative',
    'LLM proxy comparison',
    'cheapest LLM proxy',
    'AI API gateway comparison',
    'LLM cost optimization comparison',
    'Vercel AI Gateway pricing',
  ],
};

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
