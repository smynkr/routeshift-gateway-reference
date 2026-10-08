import type {
  Action,
  BlockAction,
  Condition,
  DefaultAction,
  Model,
  Policy,
  RouteAction,
  RoutingRequest,
  Rule,
  Target,
  TagAction,
  UtcWindow,
  ValidationIssue,
} from './types.js';

export class ValidationError extends Error {
  public readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

type JsonRecord = Record<string, unknown>;
type IssueList = ValidationIssue[];

function addIssue(issues: IssueList, path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

function has(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** Copy only JSON-like own data properties, so accessors and prototypes cannot affect evaluation. */
function readRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  issues: IssueList,
): JsonRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    addIssue(issues, path, 'object_required', 'Expected a JSON object.');
    return undefined;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    addIssue(issues, path, 'invalid_object', 'Expected a plain JSON object.');
  }

  const copied: JsonRecord = Object.create(null) as JsonRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      addIssue(issues, path, 'unknown_field', 'Symbol properties are not valid JSON fields.');
      continue;
    }

    const fieldPath = `${path}.${key}`;
    if (!allowedKeys.includes(key)) {
      addIssue(issues, fieldPath, 'unknown_field', `Unknown field "${key}".`);
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      addIssue(issues, fieldPath, 'invalid_property', 'Fields must be enumerable data properties.');
      continue;
    }
    copied[key] = descriptor.value;
  }

  return copied;
}

function readArray(value: unknown, path: string, issues: IssueList): unknown[] | undefined {
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'array_required', 'Expected an array.');
    return undefined;
  }

  if (Object.getPrototypeOf(value) !== Array.prototype) {
    addIssue(issues, path, 'invalid_array', 'Expected a plain JSON array.');
  }

  const length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string') {
      addIssue(issues, path, 'invalid_array_property', 'Arrays cannot have symbol properties.');
      continue;
    }
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
      addIssue(issues, `${path}.${key}`, 'invalid_array_property', 'Arrays cannot have named properties.');
    }
  }

  const copied = new Array<unknown>(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const itemPath = `${path}[${index}]`;
    if (!descriptor) {
      addIssue(issues, itemPath, 'array_hole', 'Array entries cannot be missing.');
    } else if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      addIssue(issues, itemPath, 'invalid_array_entry', 'Array entries must be enumerable data properties.');
    } else {
      copied[index] = descriptor.value;
    }
  }

  return copied;
}

function readText(
  record: JsonRecord,
  key: string,
  path: string,
  issues: IssueList,
): string | undefined {
  if (!has(record, key)) {
    addIssue(issues, `${path}.${key}`, 'required', 'This field is required.');
    return undefined;
  }
  const value = record[key];
  if (typeof value !== 'string') {
    addIssue(issues, `${path}.${key}`, 'string_required', 'Expected a string.');
    return undefined;
  }
  if (value.trim().length === 0) {
    addIssue(issues, `${path}.${key}`, 'empty_string', 'String values cannot be empty or whitespace-only.');
    return undefined;
  }
  return value;
}

function readInteger(
  record: JsonRecord,
  key: string,
  path: string,
  issues: IssueList,
  options: { minimum?: number; maximum?: number } = {},
): number | undefined {
  if (!has(record, key)) {
    addIssue(issues, `${path}.${key}`, 'required', 'This field is required.');
    return undefined;
  }

  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    addIssue(issues, `${path}.${key}`, 'safe_integer_required', 'Expected a finite safe integer.');
    return undefined;
  }
  if (options.minimum !== undefined && value < options.minimum) {
    addIssue(issues, `${path}.${key}`, 'out_of_range', `Must be at least ${options.minimum}.`);
    return undefined;
  }
  if (options.maximum !== undefined && value > options.maximum) {
    addIssue(issues, `${path}.${key}`, 'out_of_range', `Must be at most ${options.maximum}.`);
    return undefined;
  }
  return value;
}

function readStringArray(
  value: unknown,
  path: string,
  issues: IssueList,
  allowEmpty: boolean,
): string[] | undefined {
  const values = readArray(value, path, issues);
  if (!values) return undefined;
  if (!allowEmpty && values.length === 0) {
    addIssue(issues, path, 'empty_array', 'This condition array must contain at least one string.');
  }

  const result: string[] = [];
  values.forEach((item, index) => {
    if (typeof item !== 'string') {
      addIssue(issues, `${path}[${index}]`, 'string_required', 'Expected a string.');
    } else if (item.trim().length === 0) {
      addIssue(issues, `${path}[${index}]`, 'empty_string', 'String values cannot be empty or whitespace-only.');
    } else {
      result.push(item);
    }
  });
  return result;
}

function parseTarget(value: unknown, path: string, issues: IssueList): Target | undefined {
  const start = issues.length;
  const record = readRecord(value, path, ['provider', 'model'], issues);
  if (!record) return undefined;
  const provider = readText(record, 'provider', path, issues);
  const model = readText(record, 'model', path, issues);
  if (issues.length !== start || provider === undefined || model === undefined) return undefined;
  return { provider, model };
}

function parseModel(value: unknown, path: string, issues: IssueList): Model | undefined {
  const start = issues.length;
  const record = readRecord(value, path, ['provider', 'model', 'contextWindow'], issues);
  if (!record) return undefined;
  const provider = readText(record, 'provider', path, issues);
  const model = readText(record, 'model', path, issues);
  const contextWindow = readInteger(record, 'contextWindow', path, issues, { minimum: 1 });
  if (issues.length !== start || provider === undefined || model === undefined || contextWindow === undefined) {
    return undefined;
  }
  return { provider, model, contextWindow };
}

function parseUtcWindow(value: unknown, path: string, issues: IssueList): UtcWindow | undefined {
  const startIssueCount = issues.length;
  const record = readRecord(value, path, ['start', 'end'], issues);
  if (!record) return undefined;
  const start = readInteger(record, 'start', path, issues, { minimum: 0, maximum: 23 });
  const end = readInteger(record, 'end', path, issues, { minimum: 0, maximum: 23 });
  if (start !== undefined && end !== undefined && start === end) {
    addIssue(issues, path, 'ambiguous_window', 'UTC window start and end must differ.');
  }
  if (issues.length !== startIssueCount || start === undefined || end === undefined) return undefined;
  return { start, end };
}

function parseCondition(value: unknown, path: string, issues: IssueList): Condition | undefined {
  const start = issues.length;
  const record = readRecord(
    value,
    path,
    ['models', 'modelPattern', 'providers', 'allTags', 'minInputTokens', 'maxInputTokens', 'utcWindow'],
    issues,
  );
  if (!record) return undefined;

  const result: Condition = {};
  if (has(record, 'models')) {
    const models = readStringArray(record.models, `${path}.models`, issues, false);
    if (models) result.models = models;
  }
  if (has(record, 'modelPattern')) {
    const modelPattern = readText(record, 'modelPattern', path, issues);
    if (modelPattern !== undefined) result.modelPattern = modelPattern;
  }
  if (has(record, 'providers')) {
    const providers = readStringArray(record.providers, `${path}.providers`, issues, false);
    if (providers) result.providers = providers;
  }
  if (has(record, 'allTags')) {
    const allTags = readStringArray(record.allTags, `${path}.allTags`, issues, false);
    if (allTags) result.allTags = allTags;
  }
  if (has(record, 'minInputTokens')) {
    const minimum = readInteger(record, 'minInputTokens', path, issues, { minimum: 0 });
    if (minimum !== undefined) result.minInputTokens = minimum;
  }
  if (has(record, 'maxInputTokens')) {
    const maximum = readInteger(record, 'maxInputTokens', path, issues, { minimum: 0 });
    if (maximum !== undefined) result.maxInputTokens = maximum;
  }
  if (result.minInputTokens !== undefined && result.maxInputTokens !== undefined
      && result.minInputTokens > result.maxInputTokens) {
    addIssue(issues, path, 'invalid_token_range', 'minInputTokens cannot exceed maxInputTokens.');
  }
  if (has(record, 'utcWindow')) {
    const utcWindow = parseUtcWindow(record.utcWindow, `${path}.utcWindow`, issues);
    if (utcWindow) result.utcWindow = utcWindow;
  }

  return issues.length === start ? result : undefined;
}

function parseAction(
  value: unknown,
  path: string,
  issues: IssueList,
  allowTag: boolean,
): Action | DefaultAction | undefined {
  const start = issues.length;
  const actionKeys = ['type', 'target', 'reason', 'tags'];
  const record = readRecord(value, path, actionKeys, issues);
  if (!record) return undefined;
  const type = readText(record, 'type', path, issues);
  const variantKeys = type === 'route'
    ? ['type', 'target']
    : type === 'block'
      ? ['type', 'reason']
      : type === 'tag'
        ? ['type', 'tags']
        : ['type'];
  for (const key of actionKeys) {
    if (has(record, key) && !variantKeys.includes(key)) {
      addIssue(issues, `${path}.${key}`, 'unknown_field', 'This field is not valid for the action type.');
    }
  }

  let action: Action | DefaultAction | undefined;
  if (type === 'route') {
    const target = parseTarget(record.target, `${path}.target`, issues);
    if (target) action = { type: 'route', target } satisfies RouteAction;
  } else if (type === 'block') {
    const reason = readText(record, 'reason', path, issues);
    if (reason !== undefined) action = { type: 'block', reason } satisfies BlockAction;
  } else if (type === 'tag') {
    if (!allowTag) {
      addIssue(issues, `${path}.type`, 'invalid_action_type', 'The default action must be route or block.');
    } else {
      const tags = readStringArray(record.tags, `${path}.tags`, issues, true);
      if (tags) action = { type: 'tag', tags } satisfies TagAction;
    }
  } else if (type !== undefined) {
    addIssue(issues, `${path}.type`, 'invalid_action_type', 'Action type must be route, block, or tag.');
  }

  if (issues.length !== start || !action) return undefined;
  return action;
}

function parseRule(value: unknown, path: string, issues: IssueList): Rule | undefined {
  const start = issues.length;
  const record = readRecord(value, path, ['id', 'priority', 'enabled', 'when', 'then'], issues);
  if (!record) return undefined;
  const id = readText(record, 'id', path, issues);
  const priority = readInteger(record, 'priority', path, issues, { minimum: 0 });
  let enabled: boolean | undefined;
  if (has(record, 'enabled')) {
    if (typeof record.enabled !== 'boolean') {
      addIssue(issues, `${path}.enabled`, 'boolean_required', 'Expected a boolean.');
    } else {
      enabled = record.enabled;
    }
  }
  const when = has(record, 'when') ? parseCondition(record.when, `${path}.when`, issues) : undefined;
  if (!has(record, 'when')) addIssue(issues, `${path}.when`, 'required', 'This field is required.');
  const then = has(record, 'then') ? parseAction(record.then, `${path}.then`, issues, true) : undefined;
  if (!has(record, 'then')) addIssue(issues, `${path}.then`, 'required', 'This field is required.');

  if (issues.length !== start || id === undefined || priority === undefined || !when || !then) {
    return undefined;
  }
  return enabled === undefined
    ? { id, priority, when, then }
    : { id, priority, enabled, when, then };
}


export function validatePolicy(value: unknown): Policy {
  const issues: IssueList = [];
  const start = issues.length;
  const record = readRecord(value, '$', ['schemaVersion', 'id', 'revision', 'catalog', 'rules', 'defaultAction'], issues);
  if (!record) throw new ValidationError(issues);

  if (!has(record, 'schemaVersion')) {
    addIssue(issues, '$.schemaVersion', 'required', 'This field is required.');
  } else if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.schemaVersion)) {
    addIssue(issues, '$.schemaVersion', 'invalid_schema_version', 'schemaVersion must be the safe integer 1.');
  }
  const id = readText(record, 'id', '$', issues);
  const revision = readText(record, 'revision', '$', issues);

  let catalog: Model[] = [];
  if (!has(record, 'catalog')) {
    addIssue(issues, '$.catalog', 'required', 'This field is required.');
  } else {
    const values = readArray(record.catalog, '$.catalog', issues);
    if (values) {
      const seenProviders = new Map<string, Set<string>>();
      values.forEach((item, index) => {
        const model = parseModel(item, `$.catalog[${index}]`, issues);
        if (!model) return;
        let models = seenProviders.get(model.provider);
        if (!models) {
          models = new Set<string>();
          seenProviders.set(model.provider, models);
        }
        if (models.has(model.model)) {
          addIssue(issues, `$.catalog[${index}]`, 'duplicate_target', 'Catalog targets must be unique.');
        } else {
          models.add(model.model);
        }
        catalog.push(model);
      });
    }
  }

  const targets = new Set<string>();
  for (const model of catalog) {
    // Length-prefixing avoids collisions between arbitrary provider/model strings.
    const key = `${model.provider.length}:${model.provider}${model.model}`;
    targets.add(key);
  }
  const check = (action: Action | DefaultAction, path: string): void => {
    if (action.type !== 'route') return;
    const target = action.target;
    const key = `${target.provider.length}:${target.provider}${target.model}`;
    if (!targets.has(key)) {
      addIssue(issues, `${path}.target`, 'unknown_target', 'Route target must exist in the policy catalog.');
    }
  };
  let rules: Rule[] = [];
  if (!has(record, 'rules')) {
    addIssue(issues, '$.rules', 'required', 'This field is required.');
  } else {
    const values = readArray(record.rules, '$.rules', issues);
    if (values) {
      const seenIds = new Set<string>();
      values.forEach((item, index) => {
        const rule = parseRule(item, `$.rules[${index}]`, issues);
        if (!rule) return;
        check(rule.then, `$.rules[${index}].then`);
        if (seenIds.has(rule.id)) {
          addIssue(issues, `$.rules[${index}].id`, 'duplicate_rule_id', 'Rule IDs must be unique.');
        } else {
          seenIds.add(rule.id);
        }
        rules.push(rule);
      });
    }
  }

  let defaultAction: DefaultAction | undefined;
  if (!has(record, 'defaultAction')) {
    addIssue(issues, '$.defaultAction', 'required', 'This field is required.');
  } else {
    const action = parseAction(record.defaultAction, '$.defaultAction', issues, false);
    if (action && action.type !== 'tag') defaultAction = action;
  }

  if (defaultAction) check(defaultAction, '$.defaultAction');

  if (issues.length !== start || id === undefined || revision === undefined || !defaultAction) {
    throw new ValidationError(issues);
  }
  return { schemaVersion: 1, id, revision, catalog, rules, defaultAction };
}

/** Normalize duplicate request tags by preserving first occurrence and order. */
export function validateRequest(value: unknown): RoutingRequest {
  const issues: IssueList = [];
  const record = readRecord(value, '$', ['model', 'provider', 'inputTokens', 'outputTokens', 'tags', 'utcHour'], issues);
  if (!record) throw new ValidationError(issues);

  const model = readText(record, 'model', '$', issues);
  const provider = readText(record, 'provider', '$', issues);
  const inputTokens = readInteger(record, 'inputTokens', '$', issues, { minimum: 0 });
  const outputTokens = readInteger(record, 'outputTokens', '$', issues, { minimum: 0 });
  let tags: string[] = [];
  if (has(record, 'tags')) {
    const parsedTags = readStringArray(record.tags, '$.tags', issues, true);
    if (parsedTags) tags = [...new Set(parsedTags)];
  }
  let utcHour: number | undefined;
  if (has(record, 'utcHour')) {
    utcHour = readInteger(record, 'utcHour', '$', issues, { minimum: 0, maximum: 23 });
  }
  if (inputTokens !== undefined && outputTokens !== undefined
      && !Number.isSafeInteger(inputTokens + outputTokens)) {
    addIssue(issues, '$.outputTokens', 'unsafe_token_sum', 'inputTokens + outputTokens must be a safe integer.');
  }

  if (issues.length > 0 || model === undefined || provider === undefined
      || inputTokens === undefined || outputTokens === undefined) {
    throw new ValidationError(issues);
  }
  const request: RoutingRequest = { model, provider, inputTokens, outputTokens, tags };
  if (utcHour !== undefined) request.utcHour = utcHour;
  return request;
}
