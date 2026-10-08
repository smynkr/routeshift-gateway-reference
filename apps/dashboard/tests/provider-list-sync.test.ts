/**
 * Drift guard: the dashboard's provider allowlist(s) must stay in lockstep
 * with the shared catalog's PROVIDERS tuple. Three historical copies
 * (lib/provider-metadata.ts, the strategy route's inline const, and the
 * provider-keys GET listing's `const PROVIDERS`) drifted to 12 providers
 * while shared grew to 16 (xai, deepseek, mistral, meta) — silently
 * rejecting valid providers in the dashboard API and hiding stored keys
 * from the listing. Root-cause fix: ONE list, derived from
 * @routeshift/shared, imported everywhere.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROVIDERS, PROVIDERS_WITHOUT_RUNTIME_ADAPTER } from '@routeshift/shared';
import { VALID_PROVIDERS } from '../lib/provider-metadata';

describe('provider list sync with @routeshift/shared', () => {
  it('VALID_PROVIDERS exactly matches shared PROVIDERS (order-insensitive)', () => {
    expect([...VALID_PROVIDERS].sort()).toEqual([...PROVIDERS].sort());
  });

  it('VALID_PROVIDERS has no duplicates', () => {
    expect(new Set(VALID_PROVIDERS).size).toBe(VALID_PROVIDERS.length);
  });

  it('no dashboard route re-declares a local provider allowlist', () => {
    // THREE historical copies drifted to 12 providers behind shared's 16:
    // lib/provider-metadata.ts (VALID_PROVIDERS), the strategy route's inline
    // const, and provider-keys/route.ts's `const PROVIDERS` (GET listing —
    // keys could be PUT but never listed). Forbid any second site under ANY
    // allowlist name: every consumer must import the single shared-derived
    // list. The walk covers the whole dashboard tree from the root (any
    // future top-level dir is guarded by construction) and never swallows
    // walk errors — a layout change must fail loudly, not pass vacuously.
    const dashRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const canonical = join(dashRoot, 'lib', 'provider-metadata.ts');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry === 'tests') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          if (full === canonical) continue;
          const source = readFileSync(full, 'utf8');
          if (/(?:export\s+)?(?:const|let)\s+(?:VALID_)?PROVIDERS\b/.test(source)) {
            offenders.push(full);
          }
        }
      }
    };
    walk(dashRoot);
    expect(offenders, `local provider allowlist copies found: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no array literal smuggles a provider allowlist under a different name', () => {
    // The name-based guard above pins (VALID_)PROVIDERS identifiers; this
    // value-based sweep catches the same drift class under ANY name
    // (SUPPORTED_PROVIDERS, KEYABLE_PROVIDERS, …): an array literal
    // containing >= 3 known provider ids, single- OR multi-line (the
    // original offender was one id per line — opus, review round 4).
    // Legitimate subsets opt out inline with `// not-a-provider-allowlist`.
    const dashRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const known = new Set<string>(PROVIDERS);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry === 'tests') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          const source = readFileSync(full, 'utf8');
          // Match array literals across lines ([\s\S] instead of the s flag:
          // the dashboard tsconfig targets pre-es2018); skip opt-outs.
          for (const m of source.matchAll(/\[[\s\S]*?\]/g)) {
            const block = m[0];
            if (block.includes('not-a-provider-allowlist')) continue;
            // The opt-out marker may sit on the same line before OR after
            // the literal (end-of-line comment is the common style).
            const around =
              source.slice(Math.max(0, m.index - 200), m.index) +
              source.slice(m.index + block.length, m.index + block.length + 120);
            if (around.includes('not-a-provider-allowlist')) continue;
            const ids = [...block.matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
            if (ids.filter((id) => known.has(id)).length >= 3) {
              const line = source.slice(0, m.index).split('\n').length;
              offenders.push(`${full}:${line}`);
            }
          }
        }
      }
    };
    walk(dashRoot);
    expect(
      offenders,
      `array literals carrying >= 3 provider ids (drift-class allowlists under another name; opt out with \`// not-a-provider-allowlist\`):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('settings UI PROVIDER_DISPLAY covers exactly the shared provider set', () => {
    // The display list is a deliberate hand-maintained ordering, not an
    // allowlist — but a provider added to the shared tuple without a display
    // entry silently disappears from the settings UI (glm, review round 4).
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'settings', 'provider-keys-section.tsx'),
      'utf8',
    );
    const ids = [...source.matchAll(/\{ id: '([a-z0-9-]+)', name:/g)].map((m) => m[1]);
    expect(ids.length).toBe(new Set(ids).size);
    expect([...ids].sort()).toEqual([...PROVIDERS].sort());
    // Every display color must exist in COLOR_MAP (a missing key crashes the
    // settings page at render — kimi, review round 4).
    const displayColors = [...source.matchAll(/\{ id: '[a-z0-9-]+', name: '[^']+', color: '([a-z]+)'/g)].map(
      (m) => m[1],
    );
    const mapBlock = source.slice(source.indexOf('const COLOR_MAP'));
    const mapKeys = [...mapBlock.matchAll(/^ {2}([a-z]+): \{/gm)].map((m) => m[1]);
    expect(displayColors.filter((c) => !mapKeys.includes(c))).toEqual([]);
    // comingSoon must track the proxy's adapterless set exactly (opus,
    // review round 5): an adapter landing without a UI update leaves the
    // Test button hidden for a working provider; the reverse hides nothing
    // but lies about routability.
    const comingSoon = [...source.matchAll(/\{ id: '([a-z0-9-]+)', name: '[^']+', color: '[a-z]+', comingSoon: true \}/g)].map(
      (m) => m[1],
    );
    expect(comingSoon.sort()).toEqual([...PROVIDERS_WITHOUT_RUNTIME_ADAPTER].sort());
  });
});
