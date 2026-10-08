import { PluginsClient } from './plugins-client';
import { isDemoActive } from '@/lib/demo';
import { redirectToLogin } from '@/lib/login-redirect';
import { requireTeamMembership } from '@/lib/rbac';

export const metadata = { title: 'Plugins' };
export const dynamic = 'force-dynamic';

export default async function PluginsPage() {
  const member = await requireTeamMembership();
  if (!member) return redirectToLogin('/plugins');

  const demo = await isDemoActive();

  return (
    <PluginsClient
      key={`${demo ? 'demo' : 'live'}:${member.teamId}:${member.role}`}
      demo={demo}
    />
  );
}
