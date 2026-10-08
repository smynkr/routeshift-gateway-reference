import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANDING_DASHBOARD_PREVIEW_SAMPLE } from '@/lib/landing-preview-fixtures';

const repoRoot = join(__dirname, '..');
const landingSource = [
  readFileSync(join(repoRoot, 'app/page.tsx'), 'utf8'),
  readFileSync(join(repoRoot, 'components/marketing/product-proof.tsx'), 'utf8'),
].join('\n');

describe('landing page preview provenance', () => {
  it('centralizes retained preview metrics as explicit sample fixtures', () => {
    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.source).toBe('sample');
    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.label).toMatch(/sample|illustrative/i);
    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.description).toMatch(/sample|illustrative/i);
    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.description).toMatch(/not live/i);

    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.stats.length).toBeGreaterThan(0);
    for (const stat of LANDING_DASHBOARD_PREVIEW_SAMPLE.stats) {
      expect(stat.source).toBe('sample');
      expect(stat.label).toMatch(/\S/);
      expect(stat.target).toBeGreaterThan(0);
    }

    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.chartBars.length).toBeGreaterThan(0);
    for (const height of LANDING_DASHBOARD_PREVIEW_SAMPLE.chartBars) {
      expect(height).toBeGreaterThan(0);
      expect(height).toBeLessThanOrEqual(100);
    }
  });

  it('does not label fixed sample activity rows as live activity', () => {
    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.activityTitle).toMatch(/sample/i);
    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.activityTitle).not.toMatch(/^live/i);
    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.badge).toMatch(/sample/i);
    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.badge).not.toBe('Live');

    expect(LANDING_DASHBOARD_PREVIEW_SAMPLE.activityRows.length).toBeGreaterThan(0);
    for (const row of LANDING_DASHBOARD_PREVIEW_SAMPLE.activityRows) {
      expect(row.source).toBe('sample');
      expect(row.rowLabel).toMatch(/example/i);
      expect(row.rowLabel).not.toMatch(/ago$/i);
    }
  });

  it('renders sample provenance copy next to the customer-facing preview metrics', () => {
    expect(landingSource).toContain('Example workspace data');
    expect(landingSource).toContain('LANDING_DASHBOARD_PREVIEW_SAMPLE.provenance.description');
    expect(landingSource).toContain('LANDING_DASHBOARD_PREVIEW_SAMPLE.stats.map');
    expect(landingSource).toContain('LANDING_DASHBOARD_PREVIEW_SAMPLE.activityRows.map');
  });

  it('keeps fixed customer-facing preview metrics out of inline landing JSX', () => {
    expect(landingSource).not.toContain('const dashboardStats = [');
    expect(landingSource).not.toContain('const chartBars = [');
    expect(landingSource).not.toContain("time: '2s ago'");
    expect(landingSource).not.toContain('Live Activity');
    expect(landingSource).not.toContain('>Live</span>');
  });
});
