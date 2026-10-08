import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { build } from 'tsup';

const manifest = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as {
  exports: Record<string, { types: string; import: string; require: string }>;
  scripts: Record<string, string>;
};
const rootBarrel = readFileSync(resolve(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');

function rootModuleGraph(entry: string, visited = new Set<string>()): string[] {
  if (visited.has(entry)) return [];
  visited.add(entry);
  const source = readFileSync(entry, 'utf8');
  const dependencies = [...source.matchAll(/(?:import|export).*?from ['"](\.[^'"]+)['"]/g)]
    .map((match) => match[1])
    .map((specifier) => {
      const base = resolve(dirname(entry), specifier.replace(/\.js$/, '.ts'));
      return [base, `${base}.ts`, resolve(base, 'index.ts')].find(existsSync);
    })
    .filter((dependency): dependency is string => dependency !== undefined);
  return [source, ...dependencies.flatMap((dependency) => rootModuleGraph(dependency, visited))];
}

function builtModuleGraph(entry: string, visited = new Set<string>()): string[] {
  if (visited.has(entry)) return [];
  visited.add(entry);
  const source = readFileSync(entry, 'utf8');
  const dependencies = [...source.matchAll(/(?:import|export).*?from ['"](\.[^'"]+)['"]/g)]
    .map((match) => resolve(dirname(entry), match[1]));
  return [source, ...dependencies.flatMap((dependency) => builtModuleGraph(dependency, visited))];
}

describe('published entrypoint build contracts', () => {
  it('keeps clean dev builds aligned with every published Node subpath', () => {
    const entries = [
      'src/index.ts',
      'src/current-models.generated.ts',
      'src/routing.ts',
      'src/routing-browser.ts',
      'src/shadow-routing.ts',
      'src/provider-key-envelope.ts',
    ];

    for (const entry of entries) {
      expect(manifest.scripts.build).toContain(entry);
      expect(manifest.scripts.dev).toContain(entry);
    }
    expect(manifest.scripts.dev).toContain('--watch');

    expect(manifest.exports['./current-models.generated']).toEqual({
      types: './dist/current-models.generated.d.ts',
      import: './dist/current-models.generated.mjs',
      require: './dist/current-models.generated.js',
    });
    expect(manifest.exports['./routing']).toEqual({
      types: './dist/routing.d.ts',
      import: './dist/routing.mjs',
      require: './dist/routing.js',
    });
    expect(manifest.exports['./routing-browser']).toEqual({
      types: './dist/routing-browser.d.ts',
      import: './dist/routing-browser.mjs',
      require: './dist/routing-browser.js',
    });
    expect(manifest.exports['./shadow-routing']).toEqual({
      types: './dist/shadow-routing.d.ts',
      import: './dist/shadow-routing.mjs',
      require: './dist/shadow-routing.js',
    });
    expect(manifest.exports['./provider-key-envelope']).toEqual({
      types: './dist/provider-key-envelope.d.ts',
      import: './dist/provider-key-envelope.mjs',
      require: './dist/provider-key-envelope.js',
    });
  });

  it('does not re-export Node-only shadow or provider-envelope APIs from the browser-safe root barrel', () => {
    const graph = rootModuleGraph(resolve(import.meta.dirname, '..', 'src', 'index.ts')).join('\n');
    expect(rootBarrel).not.toMatch(/shadow-routing|provider-key-envelope/);
    expect(graph).not.toContain("from './shadow-routing'");
    expect(graph).not.toContain("from './provider-key-envelope'");
    expect(graph).not.toContain("from \"./shadow-routing\"");
    expect(graph).not.toContain("from \"./provider-key-envelope\"");
    expect(graph).not.toContain('node:');
  });

  it('builds and inspects a fresh browser routing graph without registry, catalog, or pricing code', async () => {
    const outDir = mkdtempSync(resolve(tmpdir(), 'routeshift-routing-browser-'));
    try {
      await build({
        entry: [resolve(import.meta.dirname, '..', 'src', 'routing-browser.ts')],
        outDir,
        format: ['esm'],
        target: 'es2022',
        platform: 'browser',
        splitting: true,
        clean: true,
        dts: false,
        config: false,
        silent: true,
      });
      const browserEntry = resolve(outDir, 'routing-browser.mjs');
      expect(existsSync(browserEntry)).toBe(true);

      const graph = builtModuleGraph(browserEntry).join('\n');
      for (const forbidden of [
        'MODEL_REGISTRY',
        'getModelContextWindow',
        'buildModelsList',
        'EFFECTIVE_PUBLIC_MODELS',
        'getModelPricing',
        'PRICING_TABLE',
        'LITELLM_GENERATED_PRICING',
      ]) {
        expect(graph, forbidden).not.toContain(forbidden);
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
