import { getEffectiveTeamId } from '@/lib/demo';
import { getActivityLogById } from '@/lib/activity-log-query';
import { requireTeamMembership } from '@/lib/rbac';
import { redirectToLogin } from '@/lib/login-redirect';
import { notFound } from 'next/navigation';
import { GenerationDetail } from './generation-detail';

export const metadata = { title: 'Generation details' };
export const dynamic = 'force-dynamic';

export default async function ActivityGenerationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const member = await requireTeamMembership();
  if (!member) return redirectToLogin(`/activity/${encodeURIComponent(id)}`);

  const teamId = await getEffectiveTeamId(member.teamId);
  if (!teamId) {
    return <p className="text-sm text-neutral-400">No team context is available for this session.</p>;
  }

  const log = await getActivityLogById(id, teamId);
  if (!log) notFound();

  return <GenerationDetail log={log} />;
}
