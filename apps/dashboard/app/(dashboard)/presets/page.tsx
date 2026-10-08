import { PresetsManager } from '@/components/presets/presets-manager';
import { isDemoActive } from '@/lib/demo';
import { redirectToLogin } from '@/lib/login-redirect';
import { hasRole, requireTeamMembership } from '@/lib/rbac';

export const metadata = { title: 'Presets' };
export const dynamic = 'force-dynamic';

export default async function PresetsPage() {
  const member = await requireTeamMembership();
  if (!member) return redirectToLogin('/presets');

  const demo = await isDemoActive();
  const canManage = !demo && hasRole(member.role, 'admin');
  const readOnlyReason = demo
    ? 'Preset management is read-only while sample data is on. Turn off sample data to change live workspace settings.'
    : 'Only admins can create, edit, disable, or delete team presets.';

  return (
    <PresetsManager
      key={`${demo ? 'demo' : 'live'}:${member.teamId}:${member.role}`}
      canManage={canManage}
      demo={demo}
      readOnlyReason={readOnlyReason}
    />
  );
}
