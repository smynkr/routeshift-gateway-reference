import { PageHeaderSkeleton, Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="max-w-xl space-y-8">
      <PageHeaderSkeleton />
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-6">
        <div className="space-y-5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
