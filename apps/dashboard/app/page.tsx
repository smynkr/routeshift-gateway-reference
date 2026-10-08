import type { Metadata } from 'next';
import { LandingContent } from '@/components/marketing/landing-content';

export const metadata: Metadata = {
  title: 'RouteShift — Explainable LLM policy routing',
  description:
    'Control where AI requests run with routing, budget, quality, and data-policy rules—then inspect the exact route and measured savings.',
};

export default function LandingPage() {
  return <LandingContent />;
}
