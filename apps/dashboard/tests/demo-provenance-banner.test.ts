import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(__dirname, '..');

describe('demo sample-data provenance UI', () => {
  it('renders a visible sample-data provenance banner in the dashboard shell', () => {
    const shellSource = readFileSync(join(repoRoot, 'components/dashboard-shell.tsx'), 'utf8');

    expect(shellSource).toContain('DemoProvenanceBanner');

    const bannerSource = readFileSync(join(repoRoot, 'components/demo-provenance-banner.tsx'), 'utf8');
    expect(bannerSource).toContain('Sample data');
    expect(bannerSource).toContain('provenance.description');
  });

  it('loads provenance from the env-gated demo API rather than trusting a raw cookie', () => {
    const bannerSource = readFileSync(join(repoRoot, 'components/demo-provenance-banner.tsx'), 'utf8');

    expect(bannerSource).toContain("fetch('/api/demo'");
    expect(bannerSource).toContain('data?.active');
    expect(bannerSource).not.toContain('document.cookie');
  });

  it('safely formats malformed generatedAt values', () => {
    const bannerSource = readFileSync(join(repoRoot, 'components/demo-provenance-banner.tsx'), 'utf8');

    expect(bannerSource).toContain('Number.isFinite(generatedDate.getTime())');
    expect(bannerSource).not.toContain('new Date(provenance.generatedAt).toISOString()');
  });

  it('refetches when the sample-data toggle changes without requiring a full reload', () => {
    const bannerSource = readFileSync(join(repoRoot, 'components/demo-provenance-banner.tsx'), 'utf8');

    expect(bannerSource).toContain("window.addEventListener('routeshift:demo-changed'");
    expect(bannerSource).toContain('cancelLoadRef.current?.()');
    expect(bannerSource).toContain('cancelLoadRef.current = loadProvenance()');
  });

  it('keeps page-level provenance visible on settings and billing demo reads', () => {
    const shellSource = readFileSync(join(repoRoot, 'components/dashboard-shell.tsx'), 'utf8');
    const demoSource = readFileSync(join(repoRoot, 'lib/demo.ts'), 'utf8');
    const toggleSource = readFileSync(join(repoRoot, 'components/demo-toggle.tsx'), 'utf8');

    expect(shellSource).toContain('<DemoProvenanceBanner />');
    expect(shellSource).not.toContain("pathname.startsWith('/settings')");
    expect(shellSource).not.toContain("pathname.startsWith('/billing')");
    expect(demoSource).toContain('seeded demo team only');
    expect(demoSource).toContain('not live spend, usage, or real activity');
    expect(demoSource).toContain('Writes and payments remain permission-gated to your workspace');
    expect(toggleSource).toContain('Showing seeded sample data');
  });
});
