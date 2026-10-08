# Explainable Policy Router

A dependency-free TypeScript library and local workbench for **deterministic routing decisions with inspectable evidence**. Write a policy, replay request metadata, and compare exactly which decisions change before adopting another policy.

**Apache-2.0 · Unmaintained reference release · No hosted service required**

This project is provided as-is. There is no support SLA, security-update commitment, hosted endpoint, or promise to review issues or pull requests. Fork it if you need a maintained version. It selects a route; it does **not** dispatch requests, authorize access, estimate tokens, or measure model quality, savings, or latency.

## Try it locally

Use Node.js 22 or 24 and npm. Run these commands from this directory; neither the RouteShift workspace nor its services are required.

```sh
npm ci --ignore-scripts
npm run build
npm test
node dist/cli.js explain --policy examples/baseline.json --request examples/request.json
node dist/cli.js demo
```

Open **http://127.0.0.1:4317/**. Edit a baseline, candidate, and request; evaluate or compare them. The workbench runs the same evaluator as the library and CLI. Its examples are explicitly synthetic, with fictional provider/model names. Editing an input clears the previous result. Selecting a scenario replaces all three editors.

No credentials, database, telemetry, remote assets, browser persistence, or paid model calls are used. The server binds only to IPv4 loopback and serves a fixed list of packaged assets. Stop it with Ctrl-C. `demo --port 0` chooses an available port; the CLI prints its URL.

## Library

After building, import `./dist/index.js` directly. Alternatively, run `npm pack` and install the resulting `routeshift-policy-router-1.0.1.tgz` in another project:

```sh
npm install /absolute/path/to/routeshift-policy-router-1.0.1.tgz
```

The package is deliberately marked `private` to prevent accidental registry publication; this does not restrict its Apache license or installation from a local package. No registry publication is implied.

```js
import { evaluate, comparePolicies, ValidationError } from '@routeshift/policy-router';

const policy = {
  schemaVersion: 1,
  id: 'example',
  revision: 'baseline',
  catalog: [
    { provider: 'demo', model: 'compact', contextWindow: 4096 },
    { provider: 'demo', model: 'large', contextWindow: 32768 },
  ],
  rules: [{
    id: 'small-request',
    priority: 10,
    when: { maxInputTokens: 3000 },
    then: { type: 'route', target: { provider: 'demo', model: 'compact' } },
  }],
  defaultAction: { type: 'route', target: { provider: 'demo', model: 'large' } },
};
const request = {
  provider: 'demo', model: 'general', inputTokens: 2000, outputTokens: 512,
};

try {
  const decision = evaluate(policy, request);
  console.log(decision.target); // { provider: 'demo', model: 'compact' }
  console.log(decision.trace);  // rule and predicate evidence, including capacity

  const candidate = structuredClone(policy);
  candidate.revision = 'candidate';
  candidate.rules[0].when.maxInputTokens = 1000;
  const comparison = comparePolicies(policy, candidate, request);
  console.log(comparison.changed); // true: candidate selects demo/large
} catch (error) {
  if (!(error instanceof ValidationError)) throw error;
  console.error(error.issues); // { path, code, message }[]
}
```

Exports: `evaluate(policy, request)`, `comparePolicies(before, after, request)`, `validatePolicy(value)`, `validateRequest(value)`, `ValidationError`, and the types in [`src/types.ts`](src/types.ts). Runtime APIs accept unknown values and validate them; TypeScript annotations alone are not the validation boundary. Validators return detached, normalized data and do not change the supplied JSON objects.

## Policy contract

`schemaVersion` is exactly `1`. `id` and `revision` are nonempty caller labels, **not signatures or authenticity guarantees**. A catalog contains unique `{provider, model, contextWindow}` entries. Every route target must exist in that catalog, including targets in disabled rules and the default action.

Each rule has a unique `id`, nonnegative safe-integer `priority`, optional boolean `enabled`, a `when` object, and a `then` action. Omitted `enabled` means enabled. Unknown fields, malformed objects, duplicate rule/catalog identities, empty condition arrays, contradictory token ranges, and unsafe numeric values are rejected before evaluation. Strings are case-sensitive and are not trimmed or case-normalized; whitespace-only identifiers are invalid.

### Conditions

| Field | Meaning |
| --- | --- |
| `models` | Match any exact request model name. |
| `modelPattern` | Full-string glob: `*` matches zero or more Unicode code points; `?` matches one. All other characters are literal, not regular-expression syntax. |
| `providers` | Match any exact incoming request provider. This does not constrain the destination provider. |
| `allTags` | Require every listed tag, including tags added by earlier rules. |
| `minInputTokens`, `maxInputTokens` | Inclusive bounds on input tokens only. |
| `utcWindow: {start, end}` | Explicit UTC hour window; start inclusive, end exclusive; overnight windows allowed. |

`models` and `modelPattern` form an **OR** group when both are present. All other configured conditions are **AND** requirements. An empty `when` object matches any valid request.

Hours are integers 0–23; equal start/end is rejected. Omit the time condition for an all-day rule. If any enabled rule uses a time window, `request.utcHour` is required before evaluation, even if an earlier rule would terminate. No system clock is consulted. Disabled time-window rules do not require a captured hour.

### Actions and order

1. Validate the complete policy and request.
2. Sort by ascending priority, preserving array order for ties.
3. Evaluate against the original request metadata and accumulated tags.
4. `{"type":"tag","tags":[...]}` adds unseen tags in order, then continues.
5. `{"type":"block","reason":"..."}` terminates with the supplied reason.
6. `{"type":"route","target":{"provider":"...","model":"..."}}` terminates only if `inputTokens + outputTokens <= contextWindow`. A capacity-rejected route continues to the next rule.
7. If no rule terminates, use the required `defaultAction`, which must be route or block. An over-capacity default route blocks with `context_capacity_exceeded`; there is no implicit pass-through target.

**Blocks are ordered rules, not forbid-overrides.** A route selected earlier prevents a later block from executing. This is routing selection, not an authorization or compliance engine. Put independent authorization controls outside it.

Requests contain `model`, `provider`, nonnegative safe-integer `inputTokens` and `outputTokens`, optional `tags`, and optional `utcHour`. The token sum must also be a safe integer. Duplicate request tags normalize to their first occurrence. There is no prompt field or tokenizer: callers supply trustworthy metadata and catalog capacities.

## Decision evidence and comparison

A decision contains:

- `policy: {id, revision}`, `outcome: 'route' | 'block'`, optional `target`;
- `ruleId` (`null` for the default action), an exact `reason`, and final `tags`;
- `trace`, with every rule in evaluation order.

Trace statuses are `disabled`, `unmatched`, `tagged`, `capacity_exceeded`, `selected`, `blocked`, and `not_evaluated`. Evaluated rules report each configured predicate's `field`, `expected`, `actual`, and `passed` result; attempted routes add a capacity result. After a terminal decision, remaining rules are `not_evaluated`, not presented as matched or failed. The default action is reported in the decision, not as an invented rule row.

A false individual `models` or `modelPattern` predicate can coexist with a selected rule because that pair is OR-combined. Use the rule status for its overall result.

`comparePolicies` returns `{changed, before, after}` with both complete decisions. `changed` compares outcome, destination, selected rule, reason, and final ordered tags. It deliberately excludes policy labels and trace-only changes. Identical destinations with different selected rules therefore count as changed; a different explanation on an unselected rule does not. Keep both traces when interpreting a comparison.

For reproducible replay, retain the exact policy/catalog and request metadata, not just their labels. Valid JSON inputs do not invoke a clock, network, randomness, or mutable global cache.

## CLI replay and comparison

```sh
node dist/cli.js explain --policy examples/baseline.json --request examples/request.json --json
node dist/cli.js replay --policy examples/baseline.json --requests examples/requests.jsonl
node dist/cli.js compare --before examples/baseline.json --after examples/candidate.json --requests examples/requests.jsonl
```

- `explain` prints a readable decision and trace, or a complete decision with `--json`.
- `replay` emits JSONL `{line, request, decision}` records. `line` is the physical, one-based input line. Blank lines are skipped; an empty input is rejected.
- `compare` emits `{total, changed, results}`. Each result includes its physical line, request, `changed` flag, and full `before`/`after` decisions.
- JSONL contains **one compact JSON request per line**, not pretty-printed multiline JSON. CRLF, LF and CR line endings are accepted.
- Replay and comparison validate/evaluate every record before writing stdout. An invalid later record produces no misleading earlier success output. They buffer input and results in memory; they are not streaming processors.
- Exit `0`: successful evaluation, including an explicit block or unchanged comparison. Exit `1`: successful comparison found changed decisions. Exit `2`: usage, validation, or I/O failure, including a closed stdout reader. Output failure takes precedence over comparison differences and stops the local demo server if its startup output cannot be written.
- Errors go to stderr. Input validation errors identify the filename and field paths/codes; JSONL errors also include the physical line. Comparison policy errors identify the before/after role. Each unknown action field is reported once, and malformed JSON excerpts are not echoed. Policy/request values and traces intentionally appear in successful output; do not put secrets in metadata or policy labels.

The shipped comparison changes only the first request's decision: `compact` becomes `large`. The fourth request changes its trace but still selects the same default destination. The other examples show cascading tags, an explicit block, and a default capacity block. These demonstrate semantics, not quality, cost, or latency outcomes.

## Architecture and limits

| Surface | Files | Boundary |
| --- | --- | --- |
| Evaluator | `src/index.ts`, `src/validate.ts`, `src/types.ts` | Browser-compatible pure policy evaluation on JSON data; no runtime packages. |
| CLI | `src/cli.ts` | Local files, explicit exit codes, evaluation-atomic JSONL batches. |
| Local server | `src/server.ts` | Loopback-only fixed asset allowlist, restrictive CSP, no write API. |
| Workbench | `web/` | Same compiled evaluator, text-only rendering of user-derived evidence, no browser persistence. |
| Examples/tests | `examples/`, `tests/` | Synthetic cases and behavioral boundary regressions. |

This is a deliberately separate, versioned contract extracted from RouteShift's explainable-routing problem—not a wire-compatible gateway replacement. It excludes provider dispatch, automatic model ranking, production catalogs and pricing datasets, billing, accounts, credential handling, and fallback execution. The original gateway is not needed at build or runtime.

Use it for local experiments or as a reviewed component in a system you own. It is not sandboxed, has no CPU/input-size quota, and should not be exposed as an unauthenticated policy-evaluation service. Very large policies, patterns, and replay files can consume substantial CPU/memory. Programmatic inputs must be plain JSON data, not objects with executable behavior. Hostile JavaScript objects are outside its security boundary.

The design keeps explicit inputs, inspectable decisions, and replay separate from execution. Related primary references: [OPA policy testing](https://www.openpolicyagent.org/docs/policy-testing), [OPA decision logs](https://www.openpolicyagent.org/docs/management-decision-logs), and [Cedar authorization semantics](https://docs.cedarpolicy.com/auth/authorization.html). This toolkit implements neither Rego nor Cedar and does not inherit their authorization guarantees.

## License and maintenance

See [LICENSE](LICENSE) for Apache License 2.0 and [NOTICE](NOTICE) for attribution and origin. This directory is the toolkit's release boundary. The license does not relicense unrelated repository content, third-party datasets, or development dependencies, which retain their own terms. The locked build uses TypeScript and Node.js type definitions; the installed runtime has no dependencies.

No commercial service, continued maintenance, security response, compatibility roadmap, model-performance claim, or employment outcome is promised. The source, examples, tests, and local workbench are intended to remain inspectable and forkable without the author operating anything.
