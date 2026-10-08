import { ChartSkeleton, KpiGridSkeleton, PageHeaderSkeleton, TableSkeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-8">
      <PageHeaderSkeleton />
      <KpiGridSkeleton count={4} />
      <ChartSkeleton />
      <TableSkeleton rows={5} cols={6} />
    </div>
  );
}
