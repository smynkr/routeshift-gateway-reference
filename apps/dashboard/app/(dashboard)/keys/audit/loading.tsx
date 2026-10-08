import { PageHeaderSkeleton, Skeleton, TableSkeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-8">
      <PageHeaderSkeleton />
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9" />
          ))}
        </div>
      </div>
      <TableSkeleton rows={6} cols={5} />
    </div>
  );
}
