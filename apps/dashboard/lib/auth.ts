import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

class AuthBackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthBackendUnavailableError';
  }
}

async function findUser(email: string) {
  if (!process.env.DATABASE_URL) {
    throw new AuthBackendUnavailableError('DATABASE_URL is not configured');
  }
  try {
    const { getPool } = await import('./db');
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name, u.password_hash,
              tm.team_id, tm.role
       FROM users u
       JOIN team_members tm ON tm.user_id = u.id
       WHERE u.email = $1
       ORDER BY CASE tm.role
                  WHEN 'owner' THEN 0
                  WHEN 'admin' THEN 1
                  ELSE 2
                END, tm.team_id
       LIMIT 1`,
      [email],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.error('Auth user lookup failed:', err);
    throw new AuthBackendUnavailableError('Authentication backend unavailable');
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email as string;
        const password = credentials?.password as string;
        if (!email || !password) return null;

        // Try DB first. Guard on a real string hash: identity/device-flow users
        // can exist with a NULL password_hash, and bcrypt.compare(password, null)
        // throws "Illegal arguments" — which would surface as a generic
        // "service unavailable" instead of a clean invalid-credentials result.
        const dbUser = await findUser(normalizeEmail(email));
        if (
          dbUser &&
          typeof dbUser.password_hash === 'string' &&
          dbUser.password_hash.length > 0 &&
          (await bcrypt.compare(password, dbUser.password_hash))
        ) {
          return { id: dbUser.id, email: dbUser.email, name: dbUser.name, teamId: dbUser.team_id, role: dbUser.role } as any;
        }

        return null;
      },
    }),
  ],
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: '/login' },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.userId = user.id;
        // Use team info already attached during authorize — avoids a second DB query
        token.teamId = (user as any).teamId ?? null;
        token.role = (user as any).role ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.userId as string;
      (session.user as any).teamId = token.teamId as string;
      (session.user as any).role = token.role as string;
      return session;
    },
  },
  secret: (() => {
    const secret = process.env.AUTH_SECRET;
    if (!secret && !process.env.NEXT_PHASE) {
      throw new Error('FATAL: AUTH_SECRET must be set. Generate one with: openssl rand -base64 32');
    }
    return secret ?? 'build-phase-placeholder';
  })(),
});
