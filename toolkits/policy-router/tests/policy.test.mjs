import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparePolicies,
  evaluate,
  ValidationError,
  validatePolicy,
  validateRequest,
} from '../dist/index.js';

const small = { provider: 'demo', model: 'small' };
const large = { provider: 'demo', model: 'large' };

function makePolicy({
  id = 'synthetic-policy',
  revision = 'r1',
  catalog = [
    { ...small, contextWindow: 16 },
    { ...large, contextWindow: 128 },
  ],
  rules = [],
  defaultAction = { type: 'route', target: large },
} = {}) {
  return { schemaVersion: 1, id, revision, catalog, rules, defaultAction };
}

function routeRule(id, priority, target = small, when = {}, extra = {}) {
  return { id, priority, when, then: { type: 'route', target }, ...extra };
}

function request(overrides = {}) {
  return {
    model: 'general',
    provider: 'demo',
    inputTokens: 3,
    outputTokens: 2,
    ...overrides,
  };
}

function errorWithIssueAt(callback, path, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ValidationError);
    assert.ok(Array.isArray(error.issues));
    assert.ok(error.issues.some((issue) => issue.path === path && issue.code === code));
    return true;
  });
}

test('model names match by exact name or full-string glob, with glob punctuation literal', () => {
  const policy = makePolicy({
    rules: [routeRule('model-match', 1, small, {
      models: ['exact-model'],
      modelPattern: 'code.+*',
    })],
  });

  const exact = evaluate(policy, request({ model: 'exact-model' }));
  assert.equal(exact.ruleId, 'model-match');
  assert.deepEqual(exact.trace[0].conditions.map(({ field }) => field), ['models', 'modelPattern', 'contextWindow']);
  assert.deepEqual(exact.trace[0].conditions.map(({ passed }) => passed), [true, false, true]);

  const patterned = evaluate(policy, request({ model: 'code.+suffix' }));
  assert.equal(patterned.ruleId, 'model-match');
  assert.deepEqual(patterned.trace[0].conditions.map(({ passed }) => passed), [false, true, true]);

  const regexLikeButNotGlob = evaluate(policy, request({ model: 'codeZZsuffix' }));
  assert.equal(regexLikeButNotGlob.ruleId, null);
  assert.equal(regexLikeButNotGlob.target.model, 'large');
});

test('glob question mark consumes one Unicode code point and matching is full-string', () => {
  const policy = makePolicy({
    rules: [routeRule('one-char', 1, small, { modelPattern: 'x-?-end' })],
  });

  assert.equal(evaluate(policy, request({ model: 'x-😀-end' })).ruleId, 'one-char');
  assert.equal(evaluate(policy, request({ model: 'prefix-x-a-end' })).ruleId, null);
  assert.equal(evaluate(policy, request({ model: 'x-ab-end' })).ruleId, null);
});

test('tag rules cascade in order, require all tags, and deduplicate with stable order', () => {
  const policy = makePolicy({
    rules: [
      {
        id: 'label-code',
        priority: 1,
        when: { modelPattern: 'code-*' },
        then: { type: 'tag', tags: ['code-path', 'seed', 'code-path'] },
      },
      routeRule('route-labeled', 2, small, { allTags: ['seed', 'code-path'] }),
    ],
  });
  const input = request({ model: 'code-review', tags: ['seed', 'seed'] });
  const result = evaluate(policy, input);

  assert.equal(result.ruleId, 'route-labeled');
  assert.deepEqual(result.tags, ['seed', 'code-path']);
  assert.deepEqual(result.trace[0].addedTags, ['code-path']);
  assert.deepEqual(result.trace[1].conditions[0].actual, ['seed', 'code-path']);
  assert.equal(result.trace[0].status, 'tagged');
});

test('ties preserve policy array order and terminal rules leave honest trace rows', () => {
  const policy = makePolicy({
    rules: [
      { id: 'disabled-first', priority: 0, enabled: false, when: { allTags: ['never'] }, then: { type: 'block', reason: 'disabled' } },
      { id: 'first-tie', priority: 5, when: {}, then: { type: 'block', reason: 'first wins' } },
      routeRule('second-tie', 5),
      { id: 'disabled-after', priority: 8, enabled: false, when: { modelPattern: 'x*' }, then: { type: 'tag', tags: ['ignored'] } },
    ],
  });
  const result = evaluate(policy, request());

  assert.equal(result.outcome, 'block');
  assert.equal(result.ruleId, 'first-tie');
  assert.equal(result.reason, 'first wins');
  assert.deepEqual(result.trace.map(({ status }) => status), ['disabled', 'blocked', 'not_evaluated', 'not_evaluated']);
  assert.deepEqual(result.trace[0].conditions, []);
  assert.deepEqual(result.trace[2].conditions, []);
});

test('every configured predicate is recorded even after an earlier mismatch', () => {
  const policy = makePolicy({
    rules: [routeRule('all-evidence', 1, small, {
      models: ['expected'],
      providers: ['another-provider'],
      allTags: ['required'],
      minInputTokens: 4,
      maxInputTokens: 8,
    })],
  });
  const result = evaluate(policy, request({ inputTokens: 3 }));

  assert.equal(result.trace[0].status, 'unmatched');
  assert.deepEqual(result.trace[0].conditions.map(({ field }) => field), [
    'models', 'providers', 'allTags', 'minInputTokens', 'maxInputTokens',
  ]);
  assert.deepEqual(result.trace[0].conditions.map(({ passed }) => passed), [false, false, false, false, true]);
  assert.equal(result.trace[0].reason, 'conditions_not_met:model,providers,allTags,minInputTokens');
});

test('capacity checks include output tokens and continue to a later larger explicit route', () => {
  const policy = makePolicy({
    catalog: [
      { ...small, contextWindow: 5 },
      { ...large, contextWindow: 10 },
    ],
    rules: [routeRule('too-small', 1, small), routeRule('large-enough', 2, large)],
  });
  const result = evaluate(policy, request({ inputTokens: 4, outputTokens: 3 }));

  assert.equal(result.outcome, 'route');
  assert.equal(result.ruleId, 'large-enough');
  assert.deepEqual(result.trace.map(({ status }) => status), ['capacity_exceeded', 'selected']);
  assert.deepEqual(result.trace[0].conditions.at(-1), {
    field: 'contextWindow',
    passed: false,
    expected: 5,
    actual: 7,
  });
});

test('default route capacity rejection blocks without inventing a rule trace', () => {
  const policy = makePolicy({
    catalog: [{ ...small, contextWindow: 5 }],
    defaultAction: { type: 'route', target: small },
  });
  const result = evaluate(policy, request({ inputTokens: 5, outputTokens: 1 }));

  assert.equal(result.outcome, 'block');
  assert.equal(result.ruleId, null);
  assert.equal(result.reason, 'context_capacity_exceeded');
  assert.equal('target' in result, false);
  assert.deepEqual(result.trace, []);
});

test('empty policy with default block is valid and returns the caller reason', () => {
  const policy = makePolicy({ catalog: [], defaultAction: { type: 'block', reason: 'no route configured' } });
  const result = evaluate(policy, request());

  assert.equal(result.outcome, 'block');
  assert.equal(result.reason, 'no route configured');
  assert.equal(result.ruleId, null);
  assert.deepEqual(result.trace, []);
});

test('overnight windows include start, exclude end, and require captured time before evaluation', () => {
  const policy = makePolicy({
    rules: [routeRule('night', 1, small, { utcWindow: { start: 22, end: 6 } })],
  });

  assert.equal(evaluate(policy, request({ utcHour: 22 })).ruleId, 'night');
  assert.equal(evaluate(policy, request({ utcHour: 5 })).ruleId, 'night');
  assert.equal(evaluate(policy, request({ utcHour: 6 })).ruleId, null);
  errorWithIssueAt(() => evaluate(policy, request()), '$.utcHour', 'required_for_policy');

  const earlierTerminal = makePolicy({
    rules: [
      { id: 'stop', priority: 0, when: {}, then: { type: 'block', reason: 'stop' } },
      routeRule('later-timed', 1, small, { utcWindow: { start: 3, end: 9 } }),
    ],
  });
  errorWithIssueAt(() => evaluate(earlierTerminal, request()), '$.utcHour', 'required_for_policy');

  const disabledWindow = makePolicy({
    rules: [{ ...routeRule('disabled-time', 0, small, { utcWindow: { start: 3, end: 9 } }), enabled: false }],
  });
  assert.equal(evaluate(disabledWindow, request()).trace[0].status, 'disabled');
});

test('validation rejects unknown fields at every JSON nesting boundary', () => {
  const badCatalog = makePolicy({ catalog: [{ ...small, contextWindow: 16, extra: true }] });
  errorWithIssueAt(() => validatePolicy(badCatalog), '$.catalog[0].extra', 'unknown_field');

  const badCondition = makePolicy({
    rules: [routeRule('bad-condition', 0, small, { modelPattern: 'x*', custom: {} })],
  });
  errorWithIssueAt(() => validatePolicy(badCondition), '$.rules[0].when.custom', 'unknown_field');

  const badAction = makePolicy({
    rules: [{ id: 'bad-action', priority: 0, when: {}, then: { type: 'route', target: small, reason: 'wrong arm' } }],
  });
  errorWithIssueAt(() => validatePolicy(badAction), '$.rules[0].then.reason', 'unknown_field');

  errorWithIssueAt(() => validateRequest({ ...request(), extra: 1 }), '$.extra', 'unknown_field');
  assert.throws(() => validatePolicy(null), ValidationError);
  assert.throws(() => validatePolicy([]), ValidationError);
  assert.throws(() => validateRequest({ ...request(), tags: null }), ValidationError);
});

test('validation checks ranges, safe integers, duplicate identifiers, and every route catalog reference', () => {
  const invalidCondition = makePolicy({
    rules: [routeRule('range', 0, small, { minInputTokens: 9, maxInputTokens: 2, allTags: [] })],
  });
  assert.throws(() => validatePolicy(invalidCondition), (error) => {
    assert.ok(error instanceof ValidationError);
    const codes = error.issues.map(({ code }) => code);
    assert.ok(codes.includes('invalid_token_range'));
    assert.ok(codes.includes('empty_array'));
    return true;
  });

  const duplicateRules = makePolicy({
    rules: [routeRule('same', 0, small), routeRule('same', 1, small)],
  });
  errorWithIssueAt(() => validatePolicy(duplicateRules), '$.rules[1].id', 'duplicate_rule_id');

  const duplicateModels = makePolicy({
    catalog: [{ ...small, contextWindow: 16 }, { ...small, contextWindow: 32 }],
    defaultAction: { type: 'block', reason: 'blocked' },
  });
  errorWithIssueAt(() => validatePolicy(duplicateModels), '$.catalog[1]', 'duplicate_target');

  const missingEvenWhenDisabled = makePolicy({
    rules: [routeRule('bad-reference', 0, { provider: 'ghost', model: 'missing' }, {}, { enabled: false })],
    defaultAction: { type: 'block', reason: 'blocked' },
  });
  errorWithIssueAt(() => validatePolicy(missingEvenWhenDisabled), '$.rules[0].then.target', 'unknown_target');

  const unsafeRequest = request({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 });
  errorWithIssueAt(() => validateRequest(unsafeRequest), '$.outputTokens', 'unsafe_token_sum');
  errorWithIssueAt(() => validateRequest(request({ inputTokens: 1.5 })), '$.inputTokens', 'safe_integer_required');
  errorWithIssueAt(() => validateRequest(request({ utcHour: 24 })), '$.utcHour', 'out_of_range');

  const equalWindow = makePolicy({ rules: [routeRule('ambiguous', 0, small, { utcWindow: { start: 4, end: 4 } })] });
  errorWithIssueAt(() => validatePolicy(equalWindow), '$.rules[0].when.utcWindow', 'ambiguous_window');
});

test('evaluation is repeatable, does not mutate inputs, and returns detached evidence', () => {
  const policy = makePolicy({
    rules: [
      { id: 'tag', priority: 1, when: {}, then: { type: 'tag', tags: ['added'] } },
      routeRule('route', 2, small, { allTags: ['added'] }),
    ],
  });
  const input = request({ tags: ['first', 'first'] });
  const policyBefore = structuredClone(policy);
  const inputBefore = structuredClone(input);
  const first = evaluate(policy, input);
  const second = evaluate(policy, input);

  assert.deepEqual(first, second);
  assert.deepEqual(policy, policyBefore);
  assert.deepEqual(input, inputBefore);
  first.tags.push('caller-change');
  first.trace[0].addedTags.push('caller-change');
  assert.deepEqual(evaluate(policy, input), second);
});

test('policy comparison ignores revision and trace-only differences but detects decision changes', () => {
  const before = makePolicy({ revision: 'before', rules: [routeRule('selected', 10, small)] });
  const traceOnlyAfter = makePolicy({
    id: 'different-policy-label',
    revision: 'after',
    rules: [
      { id: 'disabled', priority: 0, enabled: false, when: {}, then: { type: 'block', reason: 'unused' } },
      routeRule('selected', 10, small),
    ],
  });
  const traceOnly = comparePolicies(before, traceOnlyAfter, request());
  assert.equal(traceOnly.changed, false);
  assert.notDeepEqual(traceOnly.before.trace, traceOnly.after.trace);

  const changedTarget = makePolicy({ revision: 'candidate', rules: [routeRule('selected', 10, large)] });
  const changed = comparePolicies(before, changedTarget, request());
  assert.equal(changed.changed, true);
  assert.equal(changed.before.target.model, 'small');
  assert.equal(changed.after.target.model, 'large');
  assert.ok(Array.isArray(changed.before.trace));
  assert.ok(Array.isArray(changed.after.trace));
});

test('input-token bounds are inclusive and do not infer a bound from output tokens', () => {
  const policy = makePolicy({
    rules: [routeRule('bounded', 1, small, {
      modelPattern: 'general',
      providers: ['demo'],
      minInputTokens: 3,
      maxInputTokens: 3,
    })],
  });

  const exactBounds = evaluate(policy, request({ inputTokens: 3, outputTokens: 12 }));
  assert.equal(exactBounds.ruleId, 'bounded');
  assert.equal(exactBounds.reason, 'rule_selected');
  assert.equal(exactBounds.target.model, 'small');
  assert.deepEqual(exactBounds.trace[0].conditions.map(({ field, passed }) => [field, passed]), [
    ['modelPattern', true], ['providers', true], ['minInputTokens', true],
    ['maxInputTokens', true], ['contextWindow', true],
  ]);
  assert.equal(evaluate(policy, request({ inputTokens: 2 })).trace[0].status, 'unmatched');
  assert.equal(evaluate(policy, request({ inputTokens: 4 })).trace[0].status, 'unmatched');
});

test('required identifiers, schema values, rule priorities, and malformed requests fail validation', () => {
  errorWithIssueAt(() => validatePolicy(makePolicy({ id: '   ' })), '$.id', 'empty_string');
  errorWithIssueAt(() => validatePolicy({ ...makePolicy(), schemaVersion: 2 }), '$.schemaVersion', 'invalid_schema_version');
  errorWithIssueAt(() => validatePolicy(makePolicy({
    rules: [routeRule('negative-priority', -1)],
  })), '$.rules[0].priority', 'out_of_range');
  errorWithIssueAt(() => validatePolicy(makePolicy({
    catalog: [{ provider: ' ', model: 'named', contextWindow: 10 }],
    defaultAction: { type: 'block', reason: 'no route' },
  })), '$.catalog[0].provider', 'empty_string');
  errorWithIssueAt(() => validateRequest({}), '$.inputTokens', 'required');
});

test('default route decisions expose default reason and no fabricated rule rows', () => {
  const decision = evaluate(makePolicy(), request());

  assert.equal(decision.outcome, 'route');
  assert.equal(decision.ruleId, null);
  assert.equal(decision.reason, 'default_selected');
  assert.equal(decision.target.model, 'large');
  assert.deepEqual(decision.trace, []);
});

test('validation preserves original rule indices after an earlier malformed rule', () => {
  const policy = makePolicy({
    rules: [
      routeRule('bad-priority', -1),
      routeRule('bad-target', 1, { provider: 'missing', model: 'missing' }),
    ],
  });
  errorWithIssueAt(() => validatePolicy(policy), '$.rules[1].then.target', 'unknown_target');
});

test('invalid action values do not leak into validation diagnostics', () => {
  const marker = 'synthetic-private-value';
  const policy = makePolicy({ defaultAction: { type: marker, target: small } });
  assert.throws(() => validatePolicy(policy), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.ok(error.issues.some(({ code }) => code === 'invalid_action_type'));
    assert.equal(error.message.includes(marker), false);
    return true;
  });
});

test('unknown action fields are reported once without accepting fields from other action variants', () => {
  for (const [action, invalidVariantField] of [
    [{ type: 'route', target: small, reason: 'wrong variant' }, 'reason'],
    [{ type: 'block', reason: 'blocked', target: small }, 'target'],
    [{ type: 'tag', tags: ['added'], target: small }, 'target'],
  ]) {
    const policy = makePolicy({
      rules: [{ id: 'invalid-fields', priority: 0, when: {}, then: { ...action, extra: true } }],
    });
    assert.throws(() => validatePolicy(policy), (error) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(
        error.issues.map(({ path, code }) => [path, code]).sort(),
        [
          ['$.rules[0].then.extra', 'unknown_field'],
          [`$.rules[0].then.${invalidVariantField}`, 'unknown_field'],
        ].sort(),
      );
      return true;
    });
  }
});
