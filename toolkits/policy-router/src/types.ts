export interface Target {
  provider: string;
  model: string;
}

export interface Model extends Target {
  contextWindow: number;
}

export interface UtcWindow {
  start: number;
  end: number;
}

export interface Condition {
  models?: string[];
  modelPattern?: string;
  providers?: string[];
  allTags?: string[];
  minInputTokens?: number;
  maxInputTokens?: number;
  utcWindow?: UtcWindow;
}

export interface RouteAction {
  type: 'route';
  target: Target;
}

export interface BlockAction {
  type: 'block';
  reason: string;
}

export interface TagAction {
  type: 'tag';
  tags: string[];
}

export type Action = RouteAction | BlockAction | TagAction;
export type DefaultAction = RouteAction | BlockAction;

export interface Rule {
  id: string;
  priority: number;
  enabled?: boolean;
  when: Condition;
  then: Action;
}

export interface Policy {
  schemaVersion: 1;
  id: string;
  revision: string;
  catalog: Model[];
  rules: Rule[];
  defaultAction: DefaultAction;
}

export interface RoutingRequest {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  tags?: string[];
  utcHour?: number;
}

export interface ConditionResult {
  field: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export type TraceStatus =
  | 'disabled'
  | 'unmatched'
  | 'tagged'
  | 'capacity_exceeded'
  | 'selected'
  | 'blocked'
  | 'not_evaluated';

export interface TraceEntry {
  ruleId: string;
  priority: number;
  status: TraceStatus;
  reason: string;
  conditions: ConditionResult[];
  target?: Target;
  addedTags?: string[];
}

export interface Decision {
  policy: { id: string; revision: string };
  outcome: 'route' | 'block';
  target?: Target;
  ruleId: string | null;
  reason: string;
  tags: string[];
  trace: TraceEntry[];
}

export interface Comparison {
  changed: boolean;
  before: Decision;
  after: Decision;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}
