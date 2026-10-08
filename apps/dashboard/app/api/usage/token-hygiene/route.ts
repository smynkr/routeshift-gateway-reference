import { NextResponse } from 'next/server';
import { requireTeamMembership } from '@/lib/rbac';
import { getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { PROXY_URL, adminHeaders } from '@/lib/proxy';

function currentMonthIso(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function GET() {
  try {
    // Re-validate team membership against team_members rather than trusting the
    // (30-day) JWT's teamId — a removed member must not keep reading team data.
    const member = await requireTeamMembership();
    if (!member) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) {
      return NextResponse.json({ error: 'No team context' }, { status: 403 });
    }

    if (await isDemoActive()) {
      return NextResponse.json({
        summary: {
          identity_count: 3,
          average_score: 84,
          lowest_score: 72,
          total_estimated_waste_microcents: 2_450_000_000,
        },
        records: [
          {
            identity_id: 'demo:agent:codex-review',
            score: 72,
            grade: 'C',
            reasons: ['Long repeated system context', 'Low cache reuse on iterative review turns'],
            recommendations: [
              {
                code: 'compress_context',
                title: 'Compress repeated review context',
                recommendation: 'Move stable repo and ticket context into a cached prefix before reviewer-specific instructions.',
                estimated_waste_microcents: 1_100_000_000,
              },
            ],
          },
          {
            identity_id: 'demo:agent:support-router',
            score: 88,
            grade: 'B',
            reasons: ['Healthy cache reuse', 'Occasional oversized retrieval payloads'],
            recommendations: [
              {
                code: 'trim_retrieval',
                title: 'Trim low-signal retrieval rows',
                recommendation: 'Limit support-ticket retrieval to the top matching incident and compact duplicate comments.',
                estimated_waste_microcents: 850_000_000,
              },
            ],
          },
          {
            identity_id: 'demo:agent:billing-analyst',
            score: 92,
            grade: 'A',
            reasons: ['Short prompts', 'High response-cache eligibility'],
            recommendations: [],
          },
        ],
      });
    }

    const params = new URLSearchParams({ team_id: teamId, month: currentMonthIso() });
    const res = await fetch(`${PROXY_URL}/admin/usage/token-hygiene?${params.toString()}`, {
      method: 'GET',
      headers: adminHeaders(),
    });

    if (!res.ok) {
      // Don't reflect the upstream proxy's status to the browser — normalize to
      // 502 so an internal 401/5xx isn't misread as a client auth error.
      console.error(`token-hygiene upstream returned ${res.status}`);
      return NextResponse.json({ error: 'Failed to load token hygiene' }, { status: 502 });
    }

    return NextResponse.json(await res.json());
  } catch (err) {
    console.error('Token hygiene route error:', err);
    return NextResponse.json({ error: 'Failed to load token hygiene' }, { status: 500 });
  }
}
