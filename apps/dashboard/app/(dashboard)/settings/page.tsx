import { getPool } from '@/lib/db';
import { hasRole, requireTeamMembership } from '@/lib/rbac';
import { getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { redirectToLogin } from '@/lib/login-redirect';
import { CopyButton } from '@/components/copy-button';
import { formatRelative } from '@/lib/format';
import { InviteMemberDialog } from '@/components/team/invite-member-dialog';
import { MemberActions } from '@/components/team/member-actions';
import { PendingInvitations } from '@/components/team/pending-invitations';
import { BillingModeToggle } from '@/components/settings/billing-mode-toggle';
import { ProviderKeysSection } from '@/components/settings/provider-keys-section';
import { ModelAliasesSection } from '@/components/settings/model-aliases-section';
import { TeamRateLimitsSection } from '@/components/settings/team-rate-limits-section';
import { ClassifierConfigSection } from '@/components/settings/classifier-config-section';
import { GuardrailConfigSection } from '@/components/settings/guardrail-config-section';
import { PUBLIC_PROXY_BASE_URL, PUBLIC_PROXY_CHAT_COMPLETIONS_URL } from '@/lib/public-urls';
import { CURRENT_MODELS } from '@/lib/current-models';

export const metadata = { title: 'Settings' };

const SDK_QUICK_START_SNIPPET = `npm install @routeshift/sdk

import { ProxyClient } from '@routeshift/sdk';

const client = new ProxyClient({
  baseUrl: '${PUBLIC_PROXY_BASE_URL}',
  apiKey: 'sk-proxy-live_...',
});

const response = await client.chat({
  model: '${CURRENT_MODELS.default}',
  messages: [{ role: 'user', content: 'Hello!' }],
});`;

interface TeamInfo {
  id: string;
  name: string;
  plan: string;
  billing_mode: 'subscription' | 'credits';
  created_at: string;
}

interface TeamMember {
  user_id: string;
  name: string;
  email: string;
  role: string;
}

async function getTeamData(teamId: string): Promise<{ team: TeamInfo | null; members: TeamMember[]; error: string | null }> {
  try {
    const pool = getPool();

    const [teamResult, membersResult] = await Promise.all([
      pool.query(
        `SELECT id, name, plan, billing_mode, created_at FROM teams WHERE id = $1`,
        [teamId],
      ),
      pool.query(
        `SELECT u.id AS user_id, u.name, u.email, tm.role
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1
         ORDER BY tm.joined_at`,
        [teamId],
      ),
    ]);

    return {
      team: teamResult.rows[0] ?? null,
      members: membersResult.rows,
      error: null,
    };
  } catch {
    return {
      team: null,
      members: [],
      error: 'Unable to load team settings. Check the dashboard database connection and try again.',
    };
  }
}

export default async function SettingsPage() {
  const member = await requireTeamMembership();
  if (!member) {
    return redirectToLogin('/settings');
  }

  const teamId = member.teamId;
  const effectiveTeamId = (await getEffectiveTeamId(teamId)) as string;
  const demo = await isDemoActive();
  const userRole = member.role;
  const isOwner = !demo && userRole === 'owner';
  const isAdmin = !demo && hasRole(userRole, 'admin');
  const canManageProviderKeys = isAdmin;
  const { team, members, error: teamDataError } = await getTeamData(effectiveTeamId);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold text-white">Settings</h2>
        <p className="mt-1 text-neutral-400">Team configuration and environment setup.</p>
      </div>

      {demo && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-sm text-amber-300">
          Demo mode is read-only for settings. Turn off sample data to change your live workspace.
        </div>
      )}

      {teamDataError && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          <p className="font-medium">Team settings could not be loaded.</p>
          <p className="mt-1 text-red-300/80">{teamDataError}</p>
        </div>
      )}

      {/* Team Info */}
      {!teamDataError && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
          <div className="border-b border-white/[0.06] px-6 py-4">
            <h3 className="text-base font-semibold text-white">Team Info</h3>
          </div>
          <div className="divide-y divide-white/[0.06] px-6">
            {[
              { label: 'Team ID', value: <span className="flex items-center"><code className="font-mono text-sm text-neutral-300">{team?.id ?? teamId}</code><CopyButton text={team?.id ?? teamId} /></span> },
              { label: 'Name', value: <span className="text-sm font-medium text-white">{team?.name ?? 'Unknown'}</span> },
              {
                label: 'Plan',
                value: (
                  <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium capitalize text-emerald-400">
                    {team?.plan ?? 'starter'}
                  </span>
                ),
              },
              {
                label: 'Created',
                value: (
                  <span className="text-sm text-neutral-400" suppressHydrationWarning>
                    {team?.created_at ? formatRelative(team.created_at) : 'N/A'}
                  </span>
                ),
              },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between py-3.5">
                <span className="text-sm text-neutral-500">{row.label}</span>
                {row.value}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Billing Mode */}
      {!teamDataError && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
          <div className="border-b border-white/[0.06] px-6 py-4">
            <h3 className="text-base font-semibold text-white">Billing Mode</h3>
          </div>
          <div className="px-6 py-5">
            {isOwner ? (
              <BillingModeToggle currentMode={team?.billing_mode ?? 'subscription'} />
            ) : demo ? (
              <p className="text-sm text-neutral-500">
                Billing mode changes are disabled while sample data is active.
              </p>
            ) : (
              <p className="text-sm text-neutral-500">
                Only the team owner can change billing mode.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Team Members */}
      {!teamDataError && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
          <div className="border-b border-white/[0.06] px-6 py-4 flex items-center justify-between">
            <h3 className="text-base font-semibold text-white">Team Members</h3>
            {isOwner && <InviteMemberDialog />}
          </div>
          <div className="px-6">
            {members.length > 0 ? (
              <div className="divide-y divide-white/[0.06]">
                {members.map((member) => (
                  <div key={member.email} className="flex items-center justify-between py-3.5">
                    <div>
                      <p className="text-sm font-medium text-white">{member.name}</p>
                      <p className="text-sm text-neutral-500">{member.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium capitalize ${
                        member.role === 'owner'
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : member.role === 'admin'
                            ? 'bg-blue-500/10 text-blue-400'
                            : 'bg-white/[0.06] text-neutral-400'
                      }`}>
                        {member.role}
                      </span>
                      {isOwner && member.role !== 'owner' && (
                        <MemberActions
                          userId={member.user_id}
                          currentRole={member.role}
                          memberName={member.name}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-6 text-sm text-neutral-500">No members found.</p>
            )}
          </div>
        </div>
      )}

      {/* Pending Invitations (owner only) */}
      {!teamDataError && isOwner && <PendingInvitations />}

      {/* Provider Keys (subscription mode only) */}
      {!teamDataError && canManageProviderKeys && (team?.billing_mode ?? 'subscription') === 'subscription' ? (
        <ProviderKeysSection />
      ) : !teamDataError && (team?.billing_mode ?? 'subscription') === 'subscription' ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-6 py-5 text-sm text-neutral-500">
          Only admins can manage provider keys.
        </div>
      ) : null}

      {/* Model Aliases — LAY-318 */}
      <ModelAliasesSection
        canEdit={isAdmin}
        readOnlyReason={
          demo
            ? 'Demo mode — model aliases are read-only.'
            : 'Only admins can manage model aliases.'
        }
      />

      {/* Team rate limits — LAY-348 */}
      <TeamRateLimitsSection canEdit={isAdmin} />

      {/* LLM Classifier — RSH-151 */}
      <ClassifierConfigSection
        canEdit={isAdmin}
        readOnlyReason={
          demo
            ? 'Demo mode — classifier config is read-only.'
            : 'Only admins can manage classifier config.'
        }
      />

      {/* Content Guardrails — RSH-152 */}
      <GuardrailConfigSection
        canEdit={isAdmin}
        readOnlyReason={
          demo
            ? 'Demo mode — guardrail config is read-only.'
            : 'Only admins can manage guardrail config.'
        }
      />

      {/* Quick Start */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-base font-semibold text-white">Quick Start</h3>
        </div>
        <div className="space-y-5 px-6 py-5">
          <div>
            <h4 className="text-sm font-medium text-neutral-300 mb-2">1. Get your API key</h4>
            <p className="text-sm text-neutral-500">Go to API Keys and create a new key.</p>
          </div>
          <div>
            <h4 className="text-sm font-medium text-neutral-300 mb-2">2. Update your base URL</h4>
            <span className="inline-flex items-center">
              <code className="inline-block rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 font-mono text-sm text-emerald-400">
                {PUBLIC_PROXY_CHAT_COMPLETIONS_URL}
              </code>
              <CopyButton text={PUBLIC_PROXY_CHAT_COMPLETIONS_URL} />
            </span>
          </div>
          <div>
            <h4 className="text-sm font-medium text-neutral-300 mb-2">3. Set your Authorization header</h4>
            <code className="inline-block rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 font-mono text-sm text-emerald-400">
              Authorization: Bearer sk-proxy-live_...
            </code>
          </div>
          <div>
            <h4 className="text-sm font-medium text-neutral-300 mb-2">4. Or use the SDK</h4>
            <div className="relative">
              <pre className="overflow-x-auto rounded-lg border border-white/[0.06] bg-[#0c0c0e] p-4 font-mono text-sm leading-relaxed text-neutral-300">{SDK_QUICK_START_SNIPPET}</pre>
              <div className="absolute top-2 right-2">
                <CopyButton text={SDK_QUICK_START_SNIPPET} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Environment Variables */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.03]">
        <div className="border-b border-white/[0.06] px-6 py-4">
          <h3 className="text-base font-semibold text-white">Environment Variables</h3>
        </div>
        <div className="divide-y divide-white/[0.06] px-6">
          {[
            { name: 'DATABASE_URL', desc: 'PostgreSQL connection string' },
            { name: 'PROXY_URL', desc: 'Proxy server base URL' },
            { name: 'ADMIN_SECRET', desc: 'Proxy admin API secret' },
            { name: 'OPENAI_API_KEY', desc: 'OpenAI upstream API key' },
            { name: 'ANTHROPIC_API_KEY', desc: 'Anthropic upstream API key' },
            { name: 'GOOGLE_API_KEY', desc: 'Google Gemini upstream API key' },
            { name: 'TOGETHER_API_KEY', desc: 'Together AI upstream API key' },
            { name: 'GROQ_API_KEY', desc: 'Groq upstream API key' },
            { name: 'AUTH_SECRET', desc: 'NextAuth.js secret' },
          ].map(({ name, desc }) => (
            <div key={name} className="flex items-start gap-4 py-3.5">
              <code className="w-48 shrink-0 rounded bg-white/[0.04] px-2 py-0.5 font-mono text-sm text-emerald-400">
                {name}
              </code>
              <span className="text-sm text-neutral-500">{desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
