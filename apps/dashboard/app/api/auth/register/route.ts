import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { checkRateLimit, getClientIp, rateLimitedResponse } from '@/lib/rate-limit';

export async function POST(request: Request) {
  // RSH-57: unauthenticated endpoint that runs bcrypt.hashSync(cost 12) per
  // request. Throttle per IP BEFORE any JSON parsing or bcrypt work to blunt
  // CPU-exhaustion DoS and automated account creation. Keyed on the
  // non-spoofable cf-connecting-ip (see getClientIp).
  const rl = checkRateLimit(`auth:register:${getClientIp(request)}`, { limit: 5, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { email, password, name, teamName } = body;
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';

  if (!normalizedEmail || !password || !name) {
    return NextResponse.json({ error: 'Missing fields' }, { status: 400 });
  }
  if (!normalizedEmail.includes('@') || normalizedEmail.length > 255) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  }
  if (typeof name !== 'string' || name.length > 255) {
    return NextResponse.json({ error: 'Invalid name' }, { status: 400 });
  }
  // RSH-60: validate teamName like the other fields. `??` only guards null/
  // undefined, so an empty/oversized/non-string value would otherwise reach the
  // unbounded teams.name column.
  if (teamName !== undefined && (typeof teamName !== 'string' || teamName.length > 255)) {
    return NextResponse.json({ error: 'Invalid team name' }, { status: 400 });
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Registration requires DATABASE_URL' }, { status: 500 });
  }

  const { getPool } = await import('@/lib/db');
  const pool = getPool();

  // Check if email exists
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing.length > 0) {
    return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
  }

  const userId = `user_${randomUUID().slice(0, 8)}`;
  const teamId = `team_${randomUUID().slice(0, 8)}`;
  const passwordHash = bcrypt.hashSync(password, 12);

  // Create user, team, and membership in a transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [userId, normalizedEmail, name, passwordHash]);
    const resolvedTeamName =
      typeof teamName === 'string' && teamName.trim() ? teamName.trim() : `${name}'s Team`;
    await client.query('INSERT INTO teams (id, name) VALUES ($1, $2)', [teamId, resolvedTeamName]);
    await client.query('INSERT INTO team_members (user_id, team_id, role) VALUES ($1, $2, $3)', [userId, teamId, 'owner']);
    await client.query('INSERT INTO credit_balances (team_id) VALUES ($1)', [teamId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // A concurrent registration with the same email passes the non-transactional
    // pre-check above, then trips the users.email UNIQUE constraint here. That is
    // semantically a 409, not a server error.
    if ((err as { code?: string })?.code === '23505') {
      return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
    }
    console.error('Registration failed:', err);
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 });
  } finally {
    client.release();
  }

  return NextResponse.json({ userId, teamId });
}
