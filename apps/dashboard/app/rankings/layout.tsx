import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Model Rankings — Price, Context, and Sourced Capability',
  description:
    'Deterministic rankings from RouteShift’s effective public model catalog: cheapest input and output, largest context windows, and sourced capability indices when available.',
  keywords: [
    'LLM model pricing',
    'LLM context window comparison',
    'AI model catalog',
    'model capability indices',
    'RouteShift models',
  ],
};

export default function RankingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
