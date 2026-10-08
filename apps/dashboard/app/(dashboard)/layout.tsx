import { DashboardShell } from '@/components/dashboard-shell';
import { redirectToLogin } from '@/lib/login-redirect';
import { requireTeamMembership } from '@/lib/rbac';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const member = await requireTeamMembership();
  if (!member) await redirectToLogin();

  return (
    <DashboardShell>
      {children}
    </DashboardShell>
  );
}
