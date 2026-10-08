import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';
import { requireRole } from '@/lib/rbac';
import { readJsonObject } from '@/lib/request-json';
import { isHttpsUrl } from '@/lib/url';

const DEFAULT_THRESHOLD_MULTIPLIER = 2;
const DEFAULT_BASELINE_DAYS = 7;
const MAX_THRESHOLD_MULTIPLIER = 100;
const MAX_BASELINE_DAYS = 90;

type SpendAlertSettings = {
  enabled: boolean;
  webhook_url: string;
  threshold_multiplier: number;
  baseline_days: number;
};

function json(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function parseSettings(value: Record<string, unknown>): SpendAlertSettings | null {
  const { enabled, webhook_url: webhookUrl, threshold_multiplier: thresholdMultiplier, baseline_days: baselineDays } = value;
  if (typeof enabled !== 'boolean') return null;
  if (typeof webhookUrl !== 'string') return null;
  // The URL may be blank while alerts are off; enabling requires a real HTTPS endpoint.
  const webhookIsHttps = isHttpsUrl(webhookUrl);
  if (webhookUrl !== '' && !webhookIsHttps) return null;
  if (enabled && !webhookIsHttps) return null;
  if (
    typeof thresholdMultiplier !== 'number'
    || !Number.isFinite(thresholdMultiplier)
    || thresholdMultiplier < 1
    || thresholdMultiplier > MAX_THRESHOLD_MULTIPLIER
  ) return null;
  if (
    typeof baselineDays !== 'number'
    || !Number.isInteger(baselineDays)
    || baselineDays < 1
    || baselineDays > MAX_BASELINE_DAYS
  ) return null;
  return {
    enabled,
    webhook_url: webhookUrl,
    threshold_multiplier: thresholdMultiplier,
    baseline_days: baselineDays,
  };
}

export async function GET() {
  try {
    const member = await requireRole('admin');
    if (!member) return json({ error: 'Admin role required' }, 403);

    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return json({ error: 'No team context' }, 400);

    const { rows } = await getPool().query<SpendAlertSettings>(
      `SELECT enabled, webhook_url, threshold_multiplier, baseline_days
         FROM spend_alert_configs
        WHERE team_id = $1`,
      [teamId],
    );
    const settings = rows[0];
    if (!settings) {
      return json({
        enabled: false,
        webhook_url: '',
        threshold_multiplier: DEFAULT_THRESHOLD_MULTIPLIER,
        baseline_days: DEFAULT_BASELINE_DAYS,
      });
    }
    return json({
      enabled: Boolean(settings.enabled),
      webhook_url: String(settings.webhook_url ?? ''),
      threshold_multiplier: Number(settings.threshold_multiplier),
      baseline_days: Number(settings.baseline_days),
    });
  } catch (error) {
    console.error('Spend alert settings GET failed:', error);
    return json({ error: 'Failed to load spend alert settings' }, 500);
  }
}

export async function PUT(request: Request) {
  try {
    if (await isDemoActive()) return json({ error: DEMO_WRITE_BLOCKED_MESSAGE }, 403);

    const member = await requireRole('admin');
    if (!member) return json({ error: 'Admin role required' }, 403);
    const body = await readJsonObject(request);
    if (!body) return json({ error: 'Invalid JSON body' }, 400);
    const settings = parseSettings(body);
    if (!settings) {
      return json({ error: 'Webhook URL, threshold multiplier, baseline days, or enabled state is invalid' }, 400);
    }

    const teamId = await getEffectiveTeamId(member.teamId);
    if (!teamId) return json({ error: 'No team context' }, 400);

    await getPool().query(
      `INSERT INTO spend_alert_configs
         (team_id, enabled, webhook_url, threshold_multiplier, baseline_days, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (team_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         webhook_url = EXCLUDED.webhook_url,
         threshold_multiplier = EXCLUDED.threshold_multiplier,
         baseline_days = EXCLUDED.baseline_days,
         updated_at = NOW()`,
      [teamId, settings.enabled, settings.webhook_url, settings.threshold_multiplier, settings.baseline_days],
    );

    return json(settings);
  } catch (error) {
    console.error('Spend alert settings PUT failed:', error);
    return json({ error: 'Failed to save spend alert settings' }, 500);
  }
}
