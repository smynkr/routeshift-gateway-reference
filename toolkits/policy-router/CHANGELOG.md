# Changelog

## 1.0.1 — reference release corrections

- Report each unknown action field once while continuing to reject fields from other action variants.
- Identify the input file in policy and single-request validation errors, including before/after policy roles during comparison.
- Treat closed stdout as an I/O failure with exit code 2, including when a comparison found changes or the local demo server is running.
- Add behavioral regressions for these cases. Routing semantics, schema version, dependencies and the unmaintained/as-is release boundary are unchanged.

## 1.0.0 — reference release

- Standalone Apache-2.0 routing evaluator with strict runtime validation, ordered route/block/tag rules, explicit capacity checks, and complete rule/predicate traces.
- Captured UTC-hour conditions, deterministic tag cascades, stable priority ties, and no provider dispatch or runtime dependencies.
- Policy comparison that distinguishes decision changes from label-only or trace-only changes.
- Local CLI for explanations, evaluation-atomic JSONL replay, comparison, and a loopback-only browser workbench using the same evaluator.
- Synthetic examples, behavioral boundary tests, and independent Node.js 22/24 CI.
- Explicit unmaintained/as-is status; no hosted-service, registry-publication, support, savings, or model-quality promise.

The toolkit is a separate contract. No production gateway routing, billing, authentication, database schema, or customer configuration was changed.
