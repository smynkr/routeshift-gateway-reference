import { PageHeaderSkeleton, TableSkeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeaderSkeleton />
      </div>
      <TableSkeleton rows={5} cols={6} />
    </div>
  );
}
