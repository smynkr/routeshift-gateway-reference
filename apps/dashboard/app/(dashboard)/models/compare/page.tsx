import { CompareClient } from './compare-client';
import { CURRENT_MODELS } from '@/lib/current-models';

export const metadata = { title: 'Compare Models' };

interface PageProps {
  searchParams: Promise<{ a?: string; b?: string; period?: string }>;
}

export default async function CompareModelsPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  return (
    <CompareClient
      initialA={sp.a ?? CURRENT_MODELS.default}
      initialB={sp.b ?? CURRENT_MODELS.reasoning}
      initialPeriod={sp.period ?? '7d'}
    />
  );
}
