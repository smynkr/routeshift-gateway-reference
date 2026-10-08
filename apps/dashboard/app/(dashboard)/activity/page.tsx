import { parseActivityFilters, type ActivitySearchParams } from '@/lib/activity-filters';
import { ActivityClient } from './activity-client';

export const metadata = { title: 'Activity' };

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<ActivitySearchParams>;
}) {
  return <ActivityClient initialFilters={parseActivityFilters(await searchParams)} />;
}
