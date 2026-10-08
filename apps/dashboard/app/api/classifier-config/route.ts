// RSH-151: per-team LLM classifier config CRUD.
//
// GET — read the team's classifier config (or defaults if none exists)
// PUT — upsert the classifier config
//
// The proxy reads team_classifier_configs with a 5-minute in-memory cache,
// so changes propagate within that window.

import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireRole, requireTeamMembership } from '@/lib/rbac';
import { DEMO_WRITE_BLOCKED_MESSAGE, getEffectiveTeamId, isDemoActive } from '@/lib/demo';

import { selectClassifierDefaults } from '@/lib/current-models';
const MAX_DIMENSIONS = 8;
const MIN_SAMPLE_RATE_BPS = 100;
const MAX_SAMPLE_RATE_BPS = 10_000;

interface ClassifierDimension {
  id: string;
  name: string;
  prompt: string;
  values: string[];
}

interface ClassifierConfigResponse {
  enabled: boolean;
  sample_rate_bps: number;
  classifier_provider: string;
  classifier_model: string;
  dimensions: ClassifierDimension[];
}

const DEFAULTS: ClassifierConfigResponse = {
  enabled: false,
  sample_rate_bps: 1000,
  ...selectClassifierDefaults(),
  dimensions: [],
};

function sanitizeDimensions(raw: unknown): ClassifierDimension[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_DIMENSIONS).filter(
    (d): d is Record<string, unknown> =>
      typeof d === 'object' && d !== null &&
      typeof (d as Record<string, unknown>).id === 'string' &&
      typeof (d as Record<string, unknown>).name === 'string' &&
      Array.isArray((d as Record<string, unknown>).values),
  ).map((d) => ({
    id: d.id as string,
    name: d.name as string,
    prompt: typeof d.prompt === 'string' ? d.prompt : '',
    values: (d.values as unknown[]).filter((v): v is string => typeof v === 'string'),
  })).filter((d) => d.values.length > 0);
}

export async function GET() {
  try {
    const member = await requireTeamMembership();
    if (!member) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const teamId = (await getEffectiveTeamId(member.teamId)) as string;

    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT enabled, sample_rate_bps, classifier_provider, classifier_model, dimensions
       FROM team_classifier_configs WHERE team_id = $1`,
      [teamId],
    );

    if (rows.length === 0) {
      return NextResponse.json(DEFAULTS);
    }

    const row = rows[0]!;
    return NextResponse.json({
      enabled: Boolean(row.enabled),
      sample_rate_bps: Number(row.sample_rate_bps) || DEFAULTS.sample_rate_bps,
      classifier_provider: (row.classifier_provider as string) || DEFAULTS.classifier_provider,
      classifier_model: (row.classifier_model as string) || DEFAULTS.classifier_model,
      dimensions: sanitizeDimensions(row.dimensions),
    } satisfies ClassifierConfigResponse);
  } catch (err) {
    console.error('classifier-config GET error:', err);
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

    let sampleRateBps = Number(body.sample_rate_bps);
    if (!Number.isFinite(sampleRateBps)) sampleRateBps = DEFAULTS.sample_rate_bps;
    sampleRateBps = Math.min(Math.max(Math.round(sampleRateBps), MIN_SAMPLE_RATE_BPS), MAX_SAMPLE_RATE_BPS);

    const classifierProvider = typeof body.classifier_provider === 'string' && body.classifier_provider.trim()
      ? body.classifier_provider.trim()
      : DEFAULTS.classifier_provider;

    const classifierModel = typeof body.classifier_model === 'string' && body.classifier_model.trim()
      ? body.classifier_model.trim()
      : DEFAULTS.classifier_model;

    const dimensions = sanitizeDimensions(body.dimensions);

    const pool = getPool();
    await pool.query(
      `INSERT INTO team_classifier_configs (team_id, enabled, sample_rate_bps, classifier_provider, classifier_model, dimensions)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (team_id) DO UPDATE SET
         enabled = $2, sample_rate_bps = $3, classifier_provider = $4,
         classifier_model = $5, dimensions = $6, updated_at = NOW()`,
      [teamId, enabled, sampleRateBps, classifierProvider, classifierModel, JSON.stringify(dimensions)],
    );

    return NextResponse.json({
      enabled,
      sample_rate_bps: sampleRateBps,
      classifier_provider: classifierProvider,
      classifier_model: classifierModel,
      dimensions,
    } satisfies ClassifierConfigResponse);
  } catch (err) {
    console.error('classifier-config PUT error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
