import { redirect } from 'next/navigation';
import { Zap } from 'lucide-react';
import { auth } from '@/lib/auth';
import { getPool } from '@/lib/db';
import { getAuthorizationByUserCode } from '@/lib/oauth-device-service';
import { formatUserCode, normalizeUserCode, parseScopes } from '@/lib/oauth-device';
import { DeviceApprovalClient } from '@/components/device-approval-client';

// no-referrer: the user_code rides in the query string, and RFC 8628 §5.4
// warns it can leak via the Referer header to any resource the page loads.
export const metadata = { title: 'Authorize a device', referrer: 'no-referrer' as const };
export const dynamic = 'force-dynamic';

// /device — the RFC 8628 verification_uri. A signed-in user lands here (often
// via verification_uri_complete with ?user_code=...), sees which client is
// asking and for what scopes, and approves or denies. Unauthenticated users
// are bounced through SSO first and returned here.
export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) {
  const params = await searchParams;
  const rawCode = params.user_code ?? '';

  const session = await auth();
  if (!session?.user) {
    const cb = rawCode ? `/device?user_code=${encodeURIComponent(rawCode)}` : '/device';
    redirect(`/login?callbackUrl=${encodeURIComponent(cb)}`);
  }

  const normalized = normalizeUserCode(rawCode);
  let lookup: {
    found: boolean;
    clientName?: string;
    scopes?: string[];
    status?: string;
  } = { found: false };

  // The key will be minted for the approver's own team (approve binds the row
  // to the session team), so name it on the consent screen — the device that
  // started the flow has no say in the team, and the requesting client_name is
  // untrusted free text. Showing the team is the user's blast-radius signal.
  const pool = getPool();
  const sessionTeamId = (session.user as { teamId?: string }).teamId;
  let teamName = '';
  if (sessionTeamId) {
    const { rows } = await pool.query('SELECT name FROM teams WHERE id = $1', [sessionTeamId]);
    teamName = (rows[0]?.name as string | undefined) ?? '';
  }

  if (normalized) {
    const row = await getAuthorizationByUserCode(pool, normalized);
    if (row) {
      lookup = {
        found: true,
        clientName: row.client_name,
        scopes: parseScopes(row.scope),
        status: row.status,
      };
    }
  }

  return (
    <div className="relative min-h-screen bg-[#09090b] text-white">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/4 h-[600px] w-[900px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-500/[0.05] blur-[150px]" />
      </div>

      <div className="relative z-10 flex justify-center pt-12">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10">
            <Zap className="h-4 w-4 text-emerald-400" />
          </div>
          <span className="text-lg font-semibold tracking-tight text-white">RouteShift</span>
        </div>
      </div>

      <div className="relative z-10 flex min-h-[calc(100vh-80px)] items-center justify-center px-4">
        <DeviceApprovalClient
          initialUserCode={normalized ? formatUserCode(normalized) : ''}
          lookup={lookup}
          signedInAs={session.user.email ?? ''}
          teamName={teamName}
        />
      </div>
    </div>
  );
}
