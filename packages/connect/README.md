# @routeshift/connect

This private workspace package configures IDEs and agent harnesses for an operator-run
RouteShift installation. It is not published to npm. Build and run it locally from the
repository root:

```bash
pnpm --filter @routeshift/connect build
node packages/connect/dist/index.js
```

The dashboard OAuth default is `http://localhost:3000` and the inference default is
`http://localhost:4000`. Override them with `--auth-url` / `ROUTESHIFT_AUTH_URL` and
`--base-url` / `ROUTESHIFT_URL` to use your own endpoints.

When your local dashboard has its device-flow endpoints configured and running, the CLI:

1. **Signs you in** through the configured dashboard's OAuth 2.0 Device Flow (RFC 8628) — you
   approve in the browser, and a **scoped, short-lived** key is issued straight
   to the device. No long-lived secret is ever copy-pasted.
   (Use `--token <key>` if you already hold an operator-issued key.)
2. **Detects** which supported tools are installed.
3. **Writes** the correct config for each — idempotently, showing a redacted
   diff and asking for confirmation before touching anything.

```bash
node packages/connect/dist/index.js --status      # show what's configured
node packages/connect/dist/index.js disconnect    # cleanly remove only RouteShift's config
```

## Supported tools

| Tool | File | Mechanism |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL` + `env.ANTHROPIC_AUTH_TOKEN` |
| opencode | `~/.config/opencode/opencode.json` | custom OpenAI-compatible `provider.routeshift` |
| Continue / Cline | `~/.continue/config.json` | upserts a `RouteShift` model entry |
| aider / OpenAI env | `~/.routeshift/env.sh` | `OPENAI_BASE_URL` + `OPENAI_API_KEY` (source it from your shell rc) |
| Cursor | — | guided: Cursor keeps API config in app state, so `connect` prints the exact base URL + key to paste rather than writing a file it might ignore |

Force a specific tool with `--tool <id>` (repeatable). Known ids:
`claude-code`, `opencode`, `continue`, `openai-env`.

## Guarantees

- **Never clobbers your config.** Each writer owns only its own keys; everything
  else in a shared file is read, preserved, and written back. `disconnect`
  removes exactly the keys we added.
- **Keychain first for RouteShift-owned reads.** `connect` stores the minted
  token in the OS keychain (macOS Keychain / Linux Secret Service / Windows
  Credential Manager) so RouteShift's own `usage` command can read it without a
  plaintext manifest. `~/.routeshift/connect.json` stores only non-secret
  metadata such as `baseUrl`, `keyPrefix`, and managed tool paths.
- **Bounded plaintext only where third-party tools require it.** Some tools can
  only authenticate from their own config file or shell environment
  (`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, Continue/opencode `apiKey`). For
  those integrations, the token is written only to the target file with `0600`
  permissions and is removed by `disconnect`.
- **No secret in output.** The key is never printed in full to stdout, logs, or
  the diff (only the non-secret `sk-proxy-<env>_<team>` prefix is shown).
- **Idempotent.** Re-running reports "already configured" instead of rewriting.

## Keychain policy

Use the default keychain-backed mode unless you have a specific reason not to:

```bash
node packages/connect/dist/index.js --tool opencode
node packages/connect/dist/index.js usage
```

If the OS keychain is unavailable (common on headless Linux without Secret
Service), `connect` still configures requested tools and prints a redacted note;
`usage` can be run with `ROUTESHIFT_TOKEN=...`.

For CI, containers, or locked-down machines where you explicitly do not want an
OS keychain write, pass `--no-keychain`:

```bash
node packages/connect/dist/index.js --no-keychain --token sk-proxy-... --tool openai-env
```

`--no-keychain` intentionally leaves only the bounded plaintext copies required
by selected third-party tools. If a previous keychain entry exists for the same
`--base-url`, it is deleted before the manifest is marked keychain-disabled.
`disconnect` still removes RouteShift-owned plaintext tool config, but skips
keychain deletion for a no-keychain connection because no keychain entry should
remain.

## Terminal usage dashboard

`node packages/connect/dist/index.js usage` renders spend, savings, sparklines, per-model/key
breakdowns, and a contribution graph in your terminal. Auth resolves in order:
`--token` flag, `ROUTESHIFT_TOKEN` env, then the keychain entry written at
connect time. A 401 (rotated or revoked key) prints a reconnect hint and exits 1.

```bash
node packages/connect/dist/index.js usage --week
node packages/connect/dist/index.js usage --month --graph 3d
node packages/connect/dist/index.js usage --today --watch 10   # refresh every 10s (default 5s)
node packages/connect/dist/index.js usage --json               # machine-readable, for scripts
node packages/connect/dist/index.js usage --since 2026-08-01 --until 2026-09-01 --bucket day
```

CI (no keychain, no browser):

```bash
ROUTESHIFT_TOKEN=sk-proxy-... \
ROUTESHIFT_URL=http://localhost:4000 \
  node packages/connect/dist/index.js usage --week --json
```

## Two URLs

- `--auth-url` (default `$ROUTESHIFT_AUTH_URL`, otherwise `http://localhost:3000`) — where you sign in through the configured local dashboard.
- `--base-url` (default `$ROUTESHIFT_URL`, otherwise `http://localhost:4000`) — the inference base URL written into each tool's config.

## Known dependency: Anthropic surface

RouteShift currently exposes an **OpenAI-compatible** inference surface
(`/v1/chat/completions`). OpenAI-compatible tools (opencode, Continue, aider,
Cursor) route real traffic today. **Claude Code speaks the Anthropic API**, so
its writer is correct but real Claude Code traffic only flows once RouteShift
ships an Anthropic-compatible `/v1/messages` surface — `connect` prints a clear
note when it configures Claude Code. (Tracked as the RTSH-2 inference-compat
dependency.)
