// LAY-315: types for the Optimize finding engine. A "finding" is one row
// in optimize_findings — copy-paste-fixable advice with an estimated $/mo
// savings number. Each rule lives in rules/<rule>.ts and exports `detect`,
// which returns zero or one finding per team. Engine handles upsert /
// auto-resolve; rules just observe.

import type { Pool } from 'pg';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  rule_id: string;
  severity: Severity;
  estimated_savings_microcents: bigint;
  body_md: string;
  fix_md: string;
}

export interface RuleContext {
  pool: Pool;
  teamId: string;
  // Lookback in days. Rules SHOULD use this consistently — the engine sets
  // it the same for every rule run so findings are comparable.
  lookbackDays: number;
}

export interface Rule {
  id: string;
  detect(ctx: RuleContext): Promise<Finding | null>;
}
