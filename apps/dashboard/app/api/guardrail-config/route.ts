// RSH-152: per-team guardrail config CRUD.
//
// GET — read the team's guardrail config + the full built-in pattern catalog
// PUT — upsert the guardrail config (pattern overrides)
//
// The proxy reads team_guardrail_configs with a 5-minute in-memory cache,
// so changes propagate within that window.

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';

interface BuiltInPattern {
  id: string;
  name: string;
  description: string;
  category: 'pii' | 'injection';
  severity: 'block' | 'warn';
}

interface PatternOverride {
  id: string;
  enabled: boolean;
  customRegex?: string;
  action?: 'block' | 'warn';
}

// Mirrors apps/proxy/src/guardrails/patterns.ts BUILT_IN_PATTERNS (metadata only).
const BUILT_IN_PATTERNS: readonly BuiltInPattern[] = [
  { id: 'pii_email', name: 'Email address', description: 'Detects email addresses', category: 'pii', severity: 'block' },
  { id: 'pii_phone_us', name: 'US phone number', description: 'Detects US phone numbers', category: 'pii', severity: 'block' },
  { id: 'pii_ssn', name: 'Social Security Number', description: 'Detects US SSNs', category: 'pii', severity: 'block' },
  { id: 'pii_credit_card', name: 'Credit card number', description: 'Detects major credit card numbers', category: 'pii', severity: 'block' },
  { id: 'pii_ip_address', name: 'IP address', description: 'Detects IPv4 addresses', category: 'pii', severity: 'warn' },
  { id: 'pii_api_key_generic', name: 'Generic API key', description: 'Detects common API key patterns', category: 'pii', severity: 'block' },
  { id: 'pii_aws_access_key', name: 'AWS access key', description: 'Detects AWS access key IDs', category: 'pii', severity: 'block' },
  { id: 'inj_role_hijack', name: 'Role hijacking', description: 'Detects attempts to override system instructions', category: 'injection', severity: 'block' },
  { id: 'inj_identity_override', name: 'Identity override', description: 'Detects attempts to reassign the model identity', category: 'injection', severity: 'warn' },
  { id: 'inj_encoding_bypass', name: 'Encoding bypass', description: 'Detects attempts to use encoding to bypass filters', category: 'injection', severity: 'warn' },
] as const;

const BUILT_IN_IDS = new Set(BUILT_IN_PATTERNS.map((p) => p.id));
const MAX_CUSTOM_REGEX_LENGTH = 500;

function sanitizePatterns(raw: unknown): PatternOverride[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is PatternOverride =>
      typeof p === 'object' && p !== null &&
      typeof (p as Record<string, unknown>).id === 'string' &&
      typeof (p as Record<string, unknown>).enabled === 'boolean',
  ).map((p) => {
    const override: PatternOverride = { id: p.id, enabled: p.enabled };
    if (typeof p.customRegex === 'string' && p.customRegex.trim()) {
      override.customRegex = p.customRegex;
    }
    if (p.action === 'block' || p.action === 'warn') {
      override.action = p.action;
    }
    return override;
  });
}

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT enabled, config FROM team_guardrail_configs WHERE team_id = $1`,
      [teamId],
    );

    const patterns: PatternOverride[] = rows.length > 0
      ? sanitizePatterns((rows[0]!.config as Record<string, unknown> | null)?.patterns)
      : [];

    return NextResponse.json({
      enabled: rows.length > 0 ? Boolean(rows[0]!.enabled) : false,
      patterns,
      built_in_patterns: BUILT_IN_PATTERNS,
    });
  } catch (err) {
    console.error('guardrail-config GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const member = await requireRole('admin');
    if (!member) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    if (await isDemoActive()) {
      return NextResponse.json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, { status: 403 });
    }
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : false;
    const patterns = sanitizePatterns(body.patterns);

    // Validate custom regex patterns compile and are bounded.
    for (const p of patterns) {
      if (!BUILT_IN_IDS.has(p.id)) {
        return NextResponse.json(
          { error: `Unknown pattern id: "${p.id}"` },
          { status: 400 },
        );
      }
      if (p.customRegex) {
        if (p.customRegex.length > MAX_CUSTOM_REGEX_LENGTH) {
          return NextResponse.json(
            { error: `Custom regex for pattern "${p.id}" exceeds ${MAX_CUSTOM_REGEX_LENGTH} character limit` },
            { status: 400 },
          );
        }
        try {
          new RegExp(p.customRegex);
        } catch {
          return NextResponse.json(
            { error: `Invalid regex for pattern "${p.id}"` },
            { status: 400 },
          );
        }
      }
    }

    const config = JSON.stringify({ patterns });

    const pool = getPool();
    await pool.query(
      `INSERT INTO team_guardrail_configs (team_id, enabled, config)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id) DO UPDATE SET
         enabled = $2, config = $3, updated_at = NOW()`,
      [teamId, enabled, config],
    );

    return NextResponse.json({ enabled, patterns });
  } catch (err) {
    console.error('guardrail-config PUT error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
