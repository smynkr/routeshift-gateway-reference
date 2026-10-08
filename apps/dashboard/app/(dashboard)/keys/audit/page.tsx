import { hasRole, requireTeamMembership } from '@/lib/rbac';
import { isDemoActive } from '@/lib/demo';
import { redirectToLogin } from '@/lib/login-redirect';
import { ScrollText } from 'lucide-react';
import Link from 'next/link';
import { AuditFeed } from './audit-feed';

export const metadata = { title: 'Key Audit Log' };

export default async function KeysAuditPage() {
  const member = await requireTeamMembership();
  if (!member) return redirectToLogin('/keys/audit');
  // In demo mode the seeded demo user need not be an admin to view the audit
  // feed — the data is read from the seeded api_key_audit_events table.
  const canViewAudit = (await isDemoActive()) || hasRole(member.role, 'admin');

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-3">
          <Link
            href="/keys"
            className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
          >
            ← API Keys
          </Link>
        </div>
        <h2 className="mt-2 text-3xl font-bold text-white">Audit log</h2>
        <p className="mt-1 text-neutral-400">
          Every key lifecycle and guardrail event for this workspace.
        </p>
      </div>

      {!canViewAudit ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <div className="mb-4 flex justify-center">
            <ScrollText className="h-10 w-10 text-neutral-600" />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-white">Admin access required</h3>
          <p className="mx-auto max-w-md text-sm text-neutral-500">
            The audit log is only available to workspace admins. Ask an admin to upgrade your role
            if you need to investigate a key event.
          </p>
        </div>
      ) : (
        <AuditFeed />
      )}
    </div>
  );
}
