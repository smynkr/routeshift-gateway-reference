import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardRoot = join(__dirname, '..');

function read(relativePath: string): string {
  return readFileSync(join(dashboardRoot, relativePath), 'utf8');
}

describe('dashboard metadata wrappers', () => {
  it('keeps billing metadata in a server page and hooks in the client component', () => {
    const page = read('app/(dashboard)/billing/page.tsx');
    const client = read('app/(dashboard)/billing/billing-client.tsx');

    expect(page).not.toContain("'use client'");
    expect(page).toContain('BillingClient');
    expect(page).toContain('export const metadata');
    expect(client).toContain("'use client'");
  });

  it('keeps routing-new metadata in a server page and hooks in the client component', () => {
    const page = read('app/(dashboard)/routing/new/page.tsx');
    const client = read('app/(dashboard)/routing/new/new-rule-client.tsx');

    expect(page).not.toContain("'use client'");
    expect(page).toContain('NewRuleClient');
    expect(page).toContain('export const metadata');
    expect(client).toContain("'use client'");
  });
});
