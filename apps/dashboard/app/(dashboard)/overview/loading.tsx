import { ChartSkeleton, KpiGridSkeleton, PageHeaderSkeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-8">
      <PageHeaderSkeleton />
      <KpiGridSkeleton count={6} />
      <ChartSkeleton />
    </div>
  );
}
