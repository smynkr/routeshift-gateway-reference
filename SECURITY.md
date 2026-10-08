# Security posture of this reference archive

**Unmaintained; no upstream security-response or patch commitment.** This is a source reference for inspection, local evaluation and independently maintained forks—not a security-maintained gateway distribution.

Do not expose it to untrusted traffic, use real customer data, or enable real-money billing without an independent application/dependency review and appropriate remediation. Authentication and billing code existing in the archive is not a claim that the entire dependency graph is safe. Local Compose ports bind to loopback; this is exposure reduction, not a sandbox or complete security boundary.

## Known dependency-audit findings

The inherited lockfile was audited on October 6, 2026. It produced 92 advisory entries covering 77 distinct GHSA IDs: 8 critical entries, 35 high, 42 moderate and 7 low. These counts are a dated scanner result, not 92 confirmed exploitable defects. Some reports depend on operating system, optional native packages, development tooling or configurations not used by the local example.

Critical advisory identifiers in that report included:

- `GHSA-8fpg-xm3f-6cx3`, `GHSA-7rqj-j65f-68wh` — Next/Auth configuration and email-normalization reports.
- `GHSA-p293-qw3h-jr36`, `GHSA-2xp9-vwfh-vxw4` — Next platform/image-path reports.
- `GHSA-jqcg-44mw-7w3h` — proxy-addr report.
- `GHSA-5gmw-xhrv-c9v3`, `GHSA-85c8-ppgw-ccpr` — tinypool reports.

Reachability and upgrades have not been exhaustively triaged or remediated by this archive release. For example, the included dashboard uses credentials authentication rather than the email provider implicated by one report; that observation does not clear other authentication findings. There is no assertion that a scanner's severity or affected-path assessment is correct for every deployment.

Re-evaluate the exact lockfile and your actual deployment:

```sh
pnpm audit --json
```

A successful build, test suite or unauthenticated local smoke does not supersede these findings. A fork operator owns dependency updates, full authentication/tenant/billing review, provider compatibility, secret management, abuse controls, data retention and operational monitoring. Preserve the existing fail-closed budget, provider-key and tenant boundaries when updating dependencies.

## Release privacy scope

The publication is a fresh source projection, not a visibility change to the original private repository. It excludes original history, private review/audit records, operational wiki/runbooks, customer databases, issued credentials, generated coverage and hosted deployment/paid automation. Secret scanning is a bounded check, not a guarantee that every contextual privacy or security risk is absent.

The historical brand and source-code comments are not a current service offer. No author analytics property or author-hosted gateway is required by the archive's default local runtime. Operator-configured providers, analytics, payment systems and OAuth identity providers are separate external services with their own terms and costs.

## Downstream reporting

Report vulnerabilities to the maintainer of the fork or service you actually use, or through the affected dependency's security channel. Do not send credentials, customer payloads or vulnerability details to an abandoned public issue tracker. This archived repository does not promise monitoring of reports or private advisories.
