import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startDemoServer } from "../dist/server.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(packageRoot, "dist", "cli.js");
const examples = join(packageRoot, "examples");

function runCli(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

async function makeTempDir(t) {
  const directory = await mkdtemp(join(tmpdir(), "route-policy-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeTemp(directory, name, text) {
  const path = join(directory, name);
  await writeFile(path, text, "utf8");
  return path;
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}
async function fetchText(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { response, text };
}


test("explain prints complete JSON and treats a valid block as successful", async (t) => {
  const directory = await makeTempDir(t);
  const policyPath = join(examples, "baseline.json");
  const request = JSON.parse(await readFile(join(examples, "request.json"), "utf8"));
  const requestPath = await writeTemp(directory, "request.json", JSON.stringify({ ...request, tags: ["restricted"] }));

  const result = runCli(["explain", "--policy", policyPath, "--request", requestPath, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.outcome, "block");
  assert.equal(decision.reason, "restricted_workload");
  assert.ok(Array.isArray(decision.trace));
});


test("replay reports physical JSONL line numbers and skips blank lines", async (t) => {
  const directory = await makeTempDir(t);
  const request = JSON.stringify(JSON.parse(await readFile(join(examples, "request.json"), "utf8")));
  const requestsPath = await writeTemp(directory, "requests.jsonl", `\n  \n${request.trim()}\n`);
  const result = runCli([
    "replay",
    "--policy", join(examples, "baseline.json"),
    "--requests", requestsPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].line, 3);
  assert.equal(rows[0].decision.outcome, "route");
});

test("replay validates all JSONL before output and does not echo malformed source", async (t) => {
  const directory = await makeTempDir(t);
  const request = JSON.stringify(JSON.parse(await readFile(join(examples, "request.json"), "utf8")));
  const requestsPath = await writeTemp(directory, "bad.jsonl", `${request.trim()}\n{\"sensitive_marker_8421\": not-json}`);
  const result = runCli([
    "replay",
    "--policy", join(examples, "baseline.json"),
    "--requests", requestsPath,
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /line 2/);
  assert.doesNotMatch(result.stderr, /sensitive_marker_8421/);
});

test("replay rejects empty inputs and malformed requests with exit code 2", async (t) => {
  const directory = await makeTempDir(t);
  const emptyPath = await writeTemp(directory, "empty.jsonl", " \n\t\n");
  const emptyResult = runCli([
    "replay",
    "--policy", join(examples, "baseline.json"),
    "--requests", emptyPath,
  ]);
  assert.equal(emptyResult.status, 2);
  assert.equal(emptyResult.stdout, "");

  const validRequest = JSON.stringify(JSON.parse(await readFile(join(examples, "request.json"), "utf8")));
  const invalidPath = await writeTemp(directory, "invalid.jsonl", `${validRequest.trim()}\n{"model":42}\n`);
  const invalidResult = runCli([
    "replay",
    "--policy", join(examples, "baseline.json"),
    "--requests", invalidPath,
  ]);
  assert.equal(invalidResult.status, 2);
  assert.equal(invalidResult.stdout, "");
  assert.match(invalidResult.stderr, /line 2/);
});

test("compare returns differences in structured output and uses exit code 1", () => {
  const result = runCli([
    "compare",
    "--before", join(examples, "baseline.json"),
    "--after", join(examples, "candidate.json"),
    "--requests", join(examples, "requests.jsonl"),
  ]);
  assert.equal(result.status, 1, result.stderr);
  const comparison = JSON.parse(result.stdout);
  assert.equal(comparison.total, 5);
  assert.equal(comparison.changed, 1);
  assert.equal(comparison.results[0].before.target.model, "compact");
  assert.equal(comparison.results[0].after.target.model, "large");
  assert.equal(comparison.results[2].before.outcome, "block");
  assert.equal(comparison.results[2].changed, false);
});

test("compare returns exit code 0 when no decisions change", async (t) => {
  const directory = await makeTempDir(t);
  const request = JSON.stringify(JSON.parse(await readFile(join(examples, "request.json"), "utf8")));
  const requestsPath = await writeTemp(directory, "one.jsonl", request);
  const policyPath = join(examples, "baseline.json");
  const result = runCli(["compare", "--before", policyPath, "--after", policyPath, "--requests", requestsPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, 0);
});

test("CLI rejects unknown flags, duplicate flags, and missing values", () => {
  const unknown = runCli(["explain", "--policy", "p.json", "--request", "r.json", "--host", "0.0.0.0"]);
  assert.equal(unknown.status, 2);
  const duplicate = runCli(["explain", "--policy", "p.json", "--policy", "q.json", "--request", "r.json"]);
  assert.equal(duplicate.status, 2);
  const missing = runCli(["replay", "--policy"]);
  assert.equal(missing.status, 2);
});

test("validation errors identify the input file for every policy role and a single request", async (t) => {
  const directory = await makeTempDir(t);
  const validPolicyPath = join(examples, "baseline.json");
  const policy = JSON.parse(await readFile(validPolicyPath, "utf8"));
  policy.rules[0].priority = -1;
  const invalidPolicyPath = await writeTemp(directory, "invalid-policy.json", JSON.stringify(policy));
  const requestPath = join(examples, "request.json");
  const requestsPath = join(examples, "requests.jsonl");
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  request.inputTokens = -1;
  const invalidRequestPath = await writeTemp(directory, "invalid-request.json", JSON.stringify(request));

  for (const [args, inputPath, fieldPath] of [
    [["explain", "--policy", invalidPolicyPath, "--request", requestPath], invalidPolicyPath, "$.rules[0].priority"],
    [["replay", "--policy", invalidPolicyPath, "--requests", requestsPath], invalidPolicyPath, "$.rules[0].priority"],
    [["compare", "--before", invalidPolicyPath, "--after", validPolicyPath, "--requests", requestsPath], invalidPolicyPath, "$.rules[0].priority"],
    [["compare", "--before", validPolicyPath, "--after", invalidPolicyPath, "--requests", requestsPath], invalidPolicyPath, "$.rules[0].priority"],
    [["explain", "--policy", validPolicyPath, "--request", invalidRequestPath], invalidRequestPath, "$.inputTokens"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr.includes(inputPath), result.stderr);
    assert.ok(result.stderr.includes(fieldPath), result.stderr);
    assert.match(result.stderr, /\[out_of_range\]/);
  }
});

test("closed stdout is an I/O failure, including comparison and a running demo server", async (t) => {
  const directory = await makeTempDir(t);
  const request = JSON.parse(await readFile(join(examples, "request.json"), "utf8"));
  const requestsPath = await writeTemp(directory, "many.jsonl", `${JSON.stringify(request)}\n`.repeat(2000));
  const baseline = join(examples, "baseline.json");
  for (const args of [
    ["replay", "--policy", baseline, "--requests", requestsPath],
    ["compare", "--before", baseline, "--after", join(examples, "candidate.json"), "--requests", requestsPath],
    ["demo", "--port", "0"],
  ]) {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const closed = once(child, "close");
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdout.destroy();
    const [code, signal] = await closed;
    assert.equal(signal, null, stderr);
    assert.equal(code, 2, stderr);
    assert.match(stderr, /EPIPE|ECONNRESET/);
  }
});

test("server binds an ephemeral loopback port and serves only hardened allowlisted assets", async (t) => {
  const server = await startDemoServer(0);
  t.after(() => closeServer(server));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(address.address, "127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;

  const { response: page, text: pageText } = await fetchText(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html; charset=utf-8/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  const { response: queryPage, text: queryPageText } = await fetchText(`${origin}/?file=../../package.json`);
  assert.equal(queryPage.status, 200);
  assert.equal(queryPage.headers.get("content-type"), page.headers.get("content-type"));
  assert.equal(queryPageText, pageText);

  const { response: engine } = await fetchText(`${origin}/dist/index.js`);
  assert.equal(engine.status, 200);
  assert.match(engine.headers.get("content-type") ?? "", /^text\/javascript/);
  for (const path of ["/package.json", "/dist/cli.js", "/%2e%2e/package.json", "/app.js/..%2fpackage.json"]) {
    const { response } = await fetchText(`${origin}${path}`);
    assert.equal(response.status, 404, path);
  }

  const { response: head, text: headBody } = await fetchText(`${origin}/style.css`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(headBody, "");
  const { response: post } = await fetchText(`${origin}/`, { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");

});

