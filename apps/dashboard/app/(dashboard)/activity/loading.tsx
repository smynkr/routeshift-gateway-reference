import { PageHeaderSkeleton, TableSkeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <PageHeaderSkeleton />
      </div>
      <TableSkeleton rows={6} cols={7} />
    </div>
  );
}
