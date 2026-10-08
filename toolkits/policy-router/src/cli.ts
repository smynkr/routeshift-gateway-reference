#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  comparePolicies,
  evaluate,
  validatePolicy,
  ValidationError,
  type Comparison,
  type Decision,
  type Policy,
} from "./index.js";
import { startDemoServer } from "./server.js";

type FlagSpec = Readonly<Record<string, "value" | "switch">>;
type ParsedFlags = Map<string, string | true>;
type RequestRecord = { line: number; request: unknown };

const HELP = `route-policy — deterministic, explainable policy routing

Usage:
  route-policy explain --policy P.json --request R.json [--json]
  route-policy replay --policy P.json --requests requests.jsonl
  route-policy compare --before P.json --after Q.json --requests requests.jsonl
  route-policy demo [--port N]
  route-policy --help

Commands:
  explain  Evaluate one request and print its decision and rule trace.
  replay   Evaluate every nonblank JSONL request atomically.
  compare  Compare two policies for every nonblank JSONL request.
  demo     Serve the local workbench on 127.0.0.1.

Exit codes: 0 success (including a block decision), 1 comparison differences,
2 usage, validation, or I/O error.
`;

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

function parseFlags(args: readonly string[], spec: FlagSpec, required: readonly string[] = []): ParsedFlags {
  const flags: ParsedFlags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined || !flag.startsWith("--")) {
      throw new CliError(`Unexpected positional argument: ${flag ?? ""}`);
    }
    const kind = spec[flag];
    if (kind === undefined) {
      throw new CliError(`Unknown flag: ${flag}`);
    }
    if (flags.has(flag)) {
      throw new CliError(`Duplicate flag: ${flag}`);
    }
    if (kind === "switch") {
      flags.set(flag, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new CliError(`Flag ${flag} requires a value`);
    }
    flags.set(flag, value);
    index += 1;
  }
  for (const flag of required) {
    if (!flags.has(flag)) {
      throw new CliError(`Missing required flag: ${flag}`);
    }
  }
  return flags;
}

function value(flags: ParsedFlags, flag: string): string {
  const found = flags.get(flag);
  if (typeof found !== "string") {
    throw new CliError(`Missing required flag: ${flag}`);
  }
  return found;
}

function validationMessage(error: ValidationError): string {
  if (error.issues.length === 0) {
    return "validation failed";
  }
  return error.issues
    .map((issue) => `${issue.path || "<root>"} [${issue.code}]: ${issue.message}`)
    .join("; ");
}

function describeError(error: unknown): string {
  if (error instanceof CliError) {
    return error.message;
  }
  if (error instanceof ValidationError) {
    return `Validation failed: ${validationMessage(error)}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function readInputText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "I/O error";
    throw new CliError(`Unable to read ${label} file "${path}" (${code})`);
  }
}

async function readJson(path: string, label: string): Promise<unknown> {
  const contents = await readInputText(path, label);
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    // SyntaxError messages may quote attacker-controlled source; keep diagnostics content-free.
    throw new CliError(`Invalid JSON in ${label} file "${path}"`);
  }
}

async function readJsonlRequests(path: string): Promise<RequestRecord[]> {
  const contents = await readInputText(path, "requests");
  const physicalLines = contents.split(/\r\n|\n|\r/);
  const records: RequestRecord[] = [];

  for (let index = 0; index < physicalLines.length; index += 1) {
    const physicalLine = physicalLines[index] ?? "";
    let text = physicalLine.trim();
    if (index === 0) {
      text = text.replace(/^\uFEFF/, "");
    }
    if (text.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new CliError(`Invalid JSON in requests file "${path}" at line ${index + 1}`);
    }
    records.push({ line: index + 1, request: parsed });
  }

  if (records.length === 0) {
    throw new CliError(`Requests file "${path}" contains no nonblank requests`);
  }
  return records;
}
function throwRequestValidation(path: string, line: number | undefined, error: unknown): never {
  if (error instanceof ValidationError) {
    const location = line === undefined ? "" : ` at line ${line}`;
    throw new CliError(`Invalid request in "${path}"${location}: ${validationMessage(error)}`);
  }
  throw error;
}


function writeJson(valueToWrite: unknown): void {
  process.stdout.write(`${JSON.stringify(valueToWrite, null, 2)}\n`);
}

function displayValue(valueToDisplay: unknown): string {
  const json = JSON.stringify(valueToDisplay);
  return json === undefined ? String(valueToDisplay) : json;
}

function renderDecision(decision: Decision): string {
  const lines = [
    `Decision: ${decision.outcome}`,
    `Policy: ${decision.policy.id} @ ${decision.policy.revision}`,
    `Rule: ${decision.ruleId ?? "<default>"}`,
    `Reason: ${decision.reason}`,
    `Target: ${decision.target ? `${decision.target.provider}/${decision.target.model}` : "<none>"}`,
    `Tags: ${displayValue(decision.tags)}`,
    "Trace:",
  ];
  for (const entry of decision.trace) {
    lines.push(`  ${entry.ruleId} (priority ${entry.priority}) [${entry.status}]: ${entry.reason}`);
    for (const condition of entry.conditions) {
      lines.push(
        `    ${condition.field}: ${condition.passed ? "pass" : "fail"}; expected ${displayValue(condition.expected)}, actual ${displayValue(condition.actual)}`,
      );
    }
    if (entry.target) {
      lines.push(`    target: ${entry.target.provider}/${entry.target.model}`);
    }
    if (entry.addedTags && entry.addedTags.length > 0) {
      lines.push(`    added tags: ${displayValue(entry.addedTags)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

async function loadPolicy(path: string, label = "policy"): Promise<Policy> {
  const input = await readJson(path, label);
  try {
    return validatePolicy(input);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new CliError(`Invalid ${label} file "${path}": ${validationMessage(error)}`);
    }
    throw error;
  }
}

async function explain(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { "--policy": "value", "--request": "value", "--json": "switch" }, ["--policy", "--request"]);
  const policy = await loadPolicy(value(flags, "--policy"));
  const requestPath = value(flags, "--request");
  const request = await readJson(requestPath, "request");
  let decision: Decision;
  try {
    decision = evaluate(policy, request);
  } catch (error) {
    throwRequestValidation(requestPath, undefined, error);
  }
  if (flags.has("--json")) {
    writeJson(decision);
  } else {
    process.stdout.write(renderDecision(decision));
  }
  return 0;
}

async function replay(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { "--policy": "value", "--requests": "value" }, ["--policy", "--requests"]);
  const policy = await loadPolicy(value(flags, "--policy"));
  // Parse every record first; buffer all results before emitting any output.
  const requests = await readJsonlRequests(value(flags, "--requests"));
  const requestsPath = value(flags, "--requests");
  const results = requests.map(({ line, request }) => {
    try {
      return { line, request, decision: evaluate(policy, request) };
    } catch (error) {
      throwRequestValidation(requestsPath, line, error);
    }
  });
  for (const result of results) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  return 0;
}

async function compare(args: readonly string[]): Promise<number> {
  const flags = parseFlags(
    args,
    { "--before": "value", "--after": "value", "--requests": "value" },
    ["--before", "--after", "--requests"],
  );
  const before = await loadPolicy(value(flags, "--before"), "before policy");
  const after = await loadPolicy(value(flags, "--after"), "after policy");
  const requestsPath = value(flags, "--requests");
  const requests = await readJsonlRequests(requestsPath);
  const results = requests.map(({ line, request }) => {
    try {
      const comparison: Comparison = comparePolicies(before, after, request);
      return { line, request, changed: comparison.changed, before: comparison.before, after: comparison.after };
    } catch (error) {
      throwRequestValidation(requestsPath, line, error);
    }
  });
  const changed = results.reduce((count, result) => count + Number(result.changed), 0);
  writeJson({ total: results.length, changed, results });
  return changed === 0 ? 0 : 1;
}

function parsePort(valueText: string): number {
  if (!/^[0-9]+$/.test(valueText)) {
    throw new CliError(`Invalid port: ${valueText}`);
  }
  const port = Number(valueText);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`Port must be an integer from 0 to 65535: ${valueText}`);
  }
  return port;
}

async function demo(args: readonly string[]): Promise<number> {
  const flags = parseFlags(args, { "--port": "value" });
  const port = flags.has("--port") ? parsePort(value(flags, "--port")) : 4317;
  const server = await startDemoServer(port);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new CliError("Demo server did not bind a TCP port");
  }
  process.stdout.write(`Policy workbench listening at http://127.0.0.1:${address.port}/\n`);
  return 0;
}

const COMMANDS: Readonly<Record<string, true>> = {
  explain: true,
  replay: true,
  compare: true,
  demo: true,
};

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    if ((args.length === 1 && args[0] === "--help") ||
        (args.length === 2 && args[1] === "--help" && Object.hasOwn(COMMANDS, args[0] ?? ""))) {
      process.stdout.write(HELP);
      return 0;
    }
    const [command, ...commandArgs] = args;
    if (command === undefined) {
      throw new CliError("A command is required; use --help for usage");
    }
    switch (command) {
      case "explain":
        return await explain(commandArgs);
      case "replay":
        return await replay(commandArgs);
      case "compare":
        return await compare(commandArgs);
      case "demo":
        return await demo(commandArgs);
      default:
        throw new CliError(`Unknown command: ${command}`);
    }
  } catch (error) {
    process.stderr.write(`route-policy: ${describeError(error)}\n`);
    return 2;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.stdout.on("error", (error: Error) => {
    // Output is already unusable. Flush the diagnostic, then stop even if the demo server is live.
    process.stderr.write(`route-policy: ${describeError(error)}\n`, () => process.exit(2));
  });
  void main().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    process.stderr.write(`route-policy: ${describeError(error)}\n`);
    process.exitCode = 2;
  });
}
