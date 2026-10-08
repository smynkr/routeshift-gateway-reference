const ROLE_HIERARCHY: Record<string, number> = {
  owner: 100,
  admin: 50,
  member: 10,
};

export function hasRole(userRole: string, requiredRole: string): boolean {
  return (ROLE_HIERARCHY[userRole] ?? 0) >= (ROLE_HIERARCHY[requiredRole] ?? Infinity);
}

export interface AuthorizedTeamUser {
  userId: string;
  teamId: string;
  role: string;
}

export async function requireRole(requiredRole: string): Promise<AuthorizedTeamUser | null> {
  const member = await requireTeamMembership();
  if (!member) return null;
  if (!hasRole(member.role, requiredRole)) return null;
  return member;
}

export async function requireTeamMembership(): Promise<AuthorizedTeamUser | null> {
  const { auth } = await import('./auth');
  const session = await auth();
  if (!session?.user) return null;

  const userId = session.user.id as string;
  const sessionTeamId = (session.user as { teamId?: string }).teamId;
  if (!userId || !sessionTeamId) return null;

  // Demo mode must NEVER affect authorization: it only swaps READ data, which
  // each read route does itself via getEffectiveTeamId(). Resolving the role
  // here from the synthetic demo identity used to elevate any authenticated
  // user to `owner` of the demo team (privilege escalation). Always resolve the
  // caller's REAL membership/role; mutations stay scoped to their real team.
  const { getPool } = await import('./db');
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT team_id, role
       FROM team_members
      WHERE user_id = $1 AND team_id = $2
      LIMIT 1`,
    [userId, sessionTeamId],
  );
  const teamId = rows[0]?.team_id as string | undefined;
  const role = rows[0]?.role as string | undefined;

  if (!teamId || !role) return null;
  return { userId, teamId, role };
}
