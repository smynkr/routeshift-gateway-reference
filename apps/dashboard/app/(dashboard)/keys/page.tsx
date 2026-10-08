import { CopyButton } from '@/components/copy-button';
import { CreateKeyDialog } from '@/components/keys/create-key-dialog';
import { RevokeKeyButton } from '@/components/keys/revoke-key-button';
import { EditKeyDialog } from '@/components/keys/edit-key-dialog';
import { RotateKeyButton } from '@/components/keys/rotate-key-button';
import { AuditDrawerButton } from '@/components/keys/audit-drawer-button';
import Link from 'next/link';
import { hasRole, requireTeamMembership } from '@/lib/rbac';
import { PROXY_URL, adminHeaders } from '@/lib/proxy';
import { isDemoActive } from '@/lib/demo';
import { DEMO_TEAM_ID } from '@/lib/demo-constants';
import { getPool } from '@/lib/db';
import { redirectToLogin } from '@/lib/login-redirect';
import { formatRelative } from '@/lib/format';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export const metadata = { title: 'API Keys' };

async function getKeys(teamId: string) {
  if (await isDemoActive()) {
    // Demo mode: read the seeded api_keys table directly instead of the proxy.
    // Mirror the /admin/keys GET shape (id, team_id, key_prefix, name,
    // environment, metadata, created_at, last_used, expires_at) plus
    // allowed_models / rate_limit_override which the page consumes for the
    // Models column and EditKeyDialog. Active (non-revoked) keys only.
    try {
      const { rows } = await getPool().query(
        `SELECT id, team_id, key_prefix, name, environment, allowed_models,
                rate_limit_override, metadata, created_at, last_used, expires_at,
                daily_usd_cap, weekly_usd_cap, monthly_usd_cap,
                preset_slug, preset_version
           FROM api_keys
          WHERE revoked_at IS NULL AND team_id = $1
          ORDER BY created_at DESC`,
        [DEMO_TEAM_ID],
      );
      return { keys: rows, error: null };
    } catch {
      return { keys: [], error: 'Failed to load demo API keys.' };
    }
  }

  if (typeof process.env.ADMIN_SECRET !== 'string' || !process.env.ADMIN_SECRET) {
    return { keys: [], error: 'Proxy admin secret is not configured.' };
  }

  try {
    const res = await fetch(`${PROXY_URL}/admin/keys?team_id=${teamId}`, {
      headers: adminHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { keys: [], error: 'Failed to load API keys from the proxy.' };
    }
    const data = await res.json();
    return { keys: Array.isArray(data) ? data : [], error: null };
  } catch {
    return { keys: [], error: 'Failed to reach the proxy.' };
  }
}

function formatExpires(expiresAt: string | null): { text: string; expired: boolean } {
  if (!expiresAt) return { text: '—', expired: false };
  const dt = new Date(expiresAt);
  if (Number.isNaN(dt.getTime())) return { text: '—', expired: false };
  return { text: dt.toISOString().slice(0, 10), expired: dt.getTime() < Date.now() };
}

export default async function KeysPage() {
  const member = await requireTeamMembership();
  if (!member) return redirectToLogin('/keys');
  const demo = await isDemoActive();
  // In demo mode key management (create/edit/rotate/revoke) is inert: hide the
  // controls so nothing calls the proxy. Reads still render seeded keys.
  const canManageKeys = !demo && hasRole(member.role, 'admin');
  const { keys, error } = await getKeys(member.teamId);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white">API Keys</h2>
          <p className="mt-1 text-neutral-400">Manage your proxy API keys.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/keys/audit"
            className="text-sm text-neutral-400 transition-colors hover:text-neutral-200"
          >
            Audit log
          </Link>
          {canManageKeys ? (
            <CreateKeyDialog />
          ) : demo ? (
            <p className="text-sm text-neutral-500">Demo mode — key management is read-only.</p>
          ) : (
            <p className="text-sm text-neutral-500">Only admins can create or revoke API keys.</p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {!error && keys.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <p className="mb-4 text-neutral-500">
            {canManageKeys
              ? 'No API keys yet. Create one to start using the proxy.'
              : demo
                ? 'No API keys are available in this read-only demo.'
                : 'No API keys yet. Ask an admin to create one before using the proxy.'}
          </p>
          {canManageKeys && <CreateKeyDialog />}
        </div>
      ) : !error ? (
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Prefix</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Env</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>RPM</TableHead>
                <TableHead>TPM</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key: any) => {
                const allowed: string[] | null = Array.isArray(key.allowed_models) ? key.allowed_models : null;
                const rpm = key.rate_limit_override?.requests_per_minute;
                const tpm = key.rate_limit_override?.tokens_per_minute;
                const expires = formatExpires(key.expires_at ?? null);
                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-mono text-neutral-300"><span>{key.key_prefix}...</span><CopyButton text={key.key_prefix} /></TableCell>
                    <TableCell className="text-white">{key.name}</TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                          key.environment === 'live'
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-neutral-500/10 text-neutral-400'
                        }`}
                      >
                        {key.environment}
                      </span>
                    </TableCell>
                    <TableCell className="text-neutral-300">
                      {allowed && allowed.length > 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default underline decoration-dotted decoration-neutral-600 underline-offset-4">
                              {allowed.length} allowed
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="font-mono">
                            {allowed.join(', ')}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        'all'
                      )}
                    </TableCell>
                    <TableCell className="text-neutral-500">{rpm ?? 'default'}</TableCell>
                    <TableCell className="text-neutral-500">{tpm ?? '—'}</TableCell>
                    <TableCell className={expires.expired ? 'text-red-400' : 'text-neutral-500'}>
                      {expires.text}
                    </TableCell>
                    <TableCell className="text-neutral-500" suppressHydrationWarning>
                      {formatRelative(key.created_at)}
                    </TableCell>
                    <TableCell className="text-neutral-500" suppressHydrationWarning>
                      {key.last_used ? formatRelative(key.last_used) : 'Never'}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <AuditDrawerButton
                          keyId={key.id}
                          keyPrefix={key.key_prefix}
                          keyName={key.name}
                        />
                        {canManageKeys ? (
                          <>
                            <EditKeyDialog keyRow={{
                              id: key.id,
                              name: key.name,
                              allowed_models: allowed,
                              expires_at: key.expires_at ?? null,
                              rate_limit_override: key.rate_limit_override ?? null,
                              metadata: key.metadata ?? {},
                              daily_usd_cap: key.daily_usd_cap != null ? Number(key.daily_usd_cap) : null,
                              weekly_usd_cap: key.weekly_usd_cap != null ? Number(key.weekly_usd_cap) : null,
                              monthly_usd_cap: key.monthly_usd_cap != null ? Number(key.monthly_usd_cap) : null,
                              preset_slug: key.preset_slug ?? null,
                              preset_version: key.preset_version != null ? Number(key.preset_version) : null,
                            }} />
                            <RotateKeyButton keyId={key.id} keyName={key.name} />
                            <RevokeKeyButton keyId={key.id} />
                          </>
                        ) : (
                          <span className="text-xs text-neutral-500">Read only</span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
