import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_RE = /^[1-9]\d*$/;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

interface PresetVersionRow {
  version: number;
  model: string;
  params: unknown;
  system_prompt: string | null;
  provider_prefs: unknown;
  created_by: string | null;
  created_at: Date;
}

function parseVersion(value: string): number | null {
  if (!VERSION_RE.test(value)) return null;
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version > POSTGRES_INTEGER_MAX) return null;
  return version;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; version: string }> },
) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { slug, version: rawVersion } = await params;
    if (!SLUG_RE.test(slug)) {
      return NextResponse.json({ error: 'invalid_preset_slug' }, { status: 400 });
    }

    const version = parseVersion(rawVersion);
    if (version === null) {
      return NextResponse.json({ error: 'invalid_preset_version' }, { status: 400 });
    }

    const teamId = (await getEffectiveTeamId(member.teamId)) as string;
    const { rows } = await getPool().query<PresetVersionRow>(
      `SELECT pv.version, pv.model, pv.params, pv.system_prompt,
              pv.provider_prefs, pv.created_by, pv.created_at
       FROM preset_versions pv
       JOIN presets p
         ON p.id = pv.preset_id
        AND p.team_id = pv.team_id
       WHERE pv.team_id = $1
         AND p.team_id = $1
         AND p.slug = $2
         AND pv.version = $3
       LIMIT 1`,
      [teamId, slug, version],
    );

    const snapshot = rows[0];
    if (!snapshot) {
      return NextResponse.json({ error: 'preset_not_found' }, { status: 404 });
    }
    return NextResponse.json({ version: snapshot });
  } catch (err) {
    console.error('preset version GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
