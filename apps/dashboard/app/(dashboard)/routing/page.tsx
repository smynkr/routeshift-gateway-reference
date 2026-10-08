import Link from 'next/link';
import { hasRole, requireTeamMembership } from '@/lib/rbac';
import { PROXY_URL, adminHeaders } from '@/lib/proxy';
import { isDemoActive } from '@/lib/demo';
import { DEMO_TEAM_ID } from '@/lib/demo-constants';
import { getPool } from '@/lib/db';
import { redirectToLogin } from '@/lib/login-redirect';
import { Plus } from 'lucide-react';
import { RuleActions } from '@/components/routing/rule-actions';
import { AutoRouteSettings } from '@/components/routing/auto-route-settings';
import { RuleTemplateGallery } from '@/components/routing/rule-template-gallery';
import { providerDisplayName } from '@/lib/providers';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const metadata = { title: 'Routing' };

async function getRules(teamId: string) {
  if (await isDemoActive()) {
    // Demo mode: read the seeded routing_rules table directly instead of the
    // proxy. Mirror the /admin/rules GET shape and its team-plus-global ('*')
    // selection and priority ordering.
    try {
      const { rows } = await getPool().query(
        `SELECT id, team_id, name, description, priority, enabled, condition, action,
                created_at, updated_at
           FROM routing_rules
          WHERE (team_id = $1 OR team_id = '*')
          ORDER BY priority ASC`,
        [DEMO_TEAM_ID],
      );
      return { rules: rows, error: null };
    } catch {
      return { rules: [], error: 'Failed to load demo routing rules.' };
    }
  }

  if (typeof process.env.ADMIN_SECRET !== 'string' || !process.env.ADMIN_SECRET) {
    return { rules: [], error: 'Proxy admin secret is not configured.' };
  }

  try {
    const res = await fetch(`${PROXY_URL}/admin/rules?team_id=${teamId}`, {
      headers: adminHeaders(),
      cache: 'no-store',
    });
    if (!res.ok) {
      return { rules: [], error: 'Failed to load routing rules from the proxy.' };
    }
    const rules = await res.json();
    return { rules: Array.isArray(rules) ? rules : [], error: null };
  } catch {
    return { rules: [], error: 'Failed to reach the proxy.' };
  }
}

export default async function RoutingPage() {
  const member = await requireTeamMembership();
  if (!member) return redirectToLogin('/routing');
  const demo = await isDemoActive();
  // In demo mode rule management (create/edit/toggle/delete) is inert: hide the
  // controls so nothing calls the proxy. Reads still render seeded rules.
  const canManageRules = !demo && hasRole(member.role, 'admin');
  const { rules, error } = await getRules(member.teamId);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-3xl font-bold text-white">Routing Rules</h2>
          <p className="mt-1 text-neutral-400">Configure how requests are routed to providers.</p>
        </div>
        {canManageRules ? (
          <Link
            href="/routing/new"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/20"
          >
            <Plus className="h-4 w-4" />
            New Rule
          </Link>
        ) : demo ? (
          <p className="text-sm text-neutral-500">Demo mode — routing rules are read-only.</p>
        ) : (
          <p className="text-sm text-neutral-500">Only admins can create or edit team routing rules.</p>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      <AutoRouteSettings
        canEdit={canManageRules}
        readOnlyReason={
          demo
            ? 'Demo mode — auto-routing settings are read-only.'
            : 'Only admins can edit auto-routing settings.'
        }
      />
      <RuleTemplateGallery canManage={canManageRules} />

      {!error && rules.length === 0 ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.03] py-16 text-center">
          <p className="mb-4 text-neutral-500">
            {canManageRules
              ? 'No routing rules yet. Create one to start optimizing costs.'
              : demo
                ? 'No routing rules are available in this read-only demo.'
                : 'No routing rules yet. Ask an admin to create one for this team.'}
          </p>
          {canManageRules && (
            <Link
              href="/routing/new"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white transition-all hover:bg-emerald-500 hover:shadow-lg hover:shadow-emerald-500/20"
            >
              <Plus className="h-4 w-4" />
              Create First Rule
            </Link>
          )}
        </div>
      ) : !error ? (
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Priority</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Condition</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Status</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule: any) => (
                <TableRow key={rule.id}>
                  <TableCell className="font-mono text-neutral-300">{rule.priority}</TableCell>
                  <TableCell className="font-medium text-white">{rule.name}</TableCell>
                  <TableCell className="whitespace-normal text-neutral-500">
                    {summarizeCondition(rule.condition)}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                        rule.action?.type === 'block'
                          ? 'bg-red-500/10 text-red-400'
                          : rule.action?.type === 'tag'
                            ? 'bg-cyan-500/10 text-cyan-400'
                            : 'bg-emerald-500/10 text-emerald-400'
                      }`}
                    >
                      {rule.action?.type}
                    </span>
                    {rule.action?.type === 'route' && rule.action?.target_provider && (
                      <span className="ml-2 text-xs text-neutral-500">
                        {providerDisplayName(rule.action.target_provider)}
                        {rule.action.target_model ? ` \u2192 ${rule.action.target_model}` : ''}
                      </span>
                    )}
                    {rule.action?.type === 'route' && rule.action?.quality_gate && (
                      <span
                        className="ml-2 inline-flex items-center rounded-md bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-400"
                        title={
                          Array.isArray(rule.action.quality_gate?.checks)
                            ? `Quality gate — ${rule.action.quality_gate.checks.length} check(s), first failure cascades`
                            : 'Quality gate'
                        }
                      >
                        Quality gate
                      </span>
                    )}
                    {rule.action?.type !== 'route' && rule.action?.target_model && (
                      <span className="ml-2 text-sm text-neutral-500">{rule.action.target_model}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                      rule.enabled ? 'bg-emerald-500/10 text-emerald-400' : 'bg-neutral-500/10 text-neutral-500'
                    }`}>
                      {rule.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <RuleActions
                      ruleId={rule.id}
                      enabled={rule.enabled}
                      owned={rule.team_id === member.teamId}
                      canManage={canManageRules}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

function summarizeCondition(cond: any): string {
  if (!cond) return 'All requests';
  const parts: string[] = [];
  if (cond.model_requested) {
    const models = Array.isArray(cond.model_requested) ? cond.model_requested.join(', ') : cond.model_requested;
    parts.push(`model: ${models}`);
  }
  if (cond.tags?.length) parts.push(`tags: ${cond.tags.join(', ')}`);
  if (cond.max_input_tokens) parts.push(`\u2264${cond.max_input_tokens} tokens`);
  return parts.length > 0 ? parts.join(' + ') : 'All requests';
}
