import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(process.cwd(), 'src/db/migrations/059-request-logs-reasoning.sql');
const clickHouseSchemaPath = join(process.cwd(), 'src/db/clickhouse-schema.sql');

describe('reasoning request-log schema artifacts', () => {
  it('adds nullable reasoning columns in the Postgres migration', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS reasoning_tokens integer');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS reasoning_cost_microcents bigint');
  });

  it('declares nullable reasoning columns in the ClickHouse schema', () => {
    const schema = readFileSync(clickHouseSchemaPath, 'utf8');

    expect(schema).toContain('reasoning_tokens Nullable(UInt32) DEFAULT NULL');
    expect(schema).toContain('reasoning_cost_microcents Nullable(Int64) DEFAULT NULL');
  });
});
