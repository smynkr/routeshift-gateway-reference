import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { GatewayBenchmarkReport } from './latency-harness.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const tempDirectory = mkdtempSync(join(tmpdir(), 'routeshift-latency-'));
const outputPath = join(tempDirectory, 'result.json');

try {
  const result = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'bench', 'tests/latency.bench.ts', '--run'],
    {
      cwd: packageRoot,
      env: { ...process.env, ROUTESHIFT_BENCHMARK_OUTPUT: outputPath },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Vitest latency benchmark exited with status ${String(result.status)}`);
  }

  const report = JSON.parse(readFileSync(outputPath, 'utf8')) as GatewayBenchmarkReport;
  if (report.schema !== 'routeshift.gateway-latency.v1') {
    throw new Error(`Unexpected latency benchmark schema: ${String(report.schema)}`);
  }
  if (report.environment.dirty && process.env.ROUTESHIFT_BENCHMARK_ALLOW_DIRTY !== '1') {
    throw new Error('Refusing to publish a latency result from a dirty worktree');
  }

  process.stdout.write(`\nRSH97_GATEWAY_LATENCY_JSON=${JSON.stringify(report)}\n`);
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
