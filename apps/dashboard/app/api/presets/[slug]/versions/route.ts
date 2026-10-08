import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { getEffectiveTeamId } from '@/lib/demo';
import { requireTeamMembership } from '@/lib/rbac';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface PresetVersionRow {
  version: number;
  model: string;
  params: unknown;
  system_prompt: string | null;
  provider_prefs: unknown;
  created_by: string | null;
  created_at: Date;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { slug } = await params;
    if (!SLUG_RE.test(slug)) {
      return NextResponse.json({ error: 'invalid_preset_slug' }, { status: 400 });
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
       ORDER BY pv.version DESC`,
      [teamId, slug],
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: 'preset_not_found' }, { status: 404 });
    }
    return NextResponse.json({ versions: rows });
  } catch (err) {
    console.error('preset versions GET error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
