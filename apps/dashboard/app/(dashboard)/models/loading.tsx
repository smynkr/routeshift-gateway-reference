import { PageHeaderSkeleton, TableSkeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="space-y-8">
      <PageHeaderSkeleton />
      <div className="space-y-6">
        <TableSkeleton rows={3} cols={5} />
        <TableSkeleton rows={3} cols={5} />
      </div>
    </div>
  );
}
