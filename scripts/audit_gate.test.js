const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, test } = require("node:test");

const directory = mkdtempSync(join(tmpdir(), "vinufinance-audit-gate-"));
after(() => rmSync(directory, { recursive: true, force: true }));

function run(vulnerabilities) {
  const input = join(directory, `${Math.random()}.jsonl`);
  writeFileSync(input, `${JSON.stringify({ type: "auditSummary", data: { vulnerabilities } })}\n`);
  return spawnSync(process.execPath, [join(__dirname, "audit_gate.js"), input], { encoding: "utf8" });
}

test("accepts a clean audit summary", () => {
  assert.equal(run({ high: 0, critical: 0 }).status, 0);
});

test("rejects summary-only high and critical advisories", () => {
  assert.equal(run({ high: 1, critical: 0 }).status, 1);
  assert.equal(run({ high: 0, critical: 1 }).status, 1);
});

test("rejects malformed audit summaries", () => {
  assert.equal(run({ high: 0 }).status, 1);
});

function runAdvisories(scope, summaryHigh, advisories) {
  const input = join(directory, `${Math.random()}.jsonl`);
  const lines = advisories.map((advisory) => ({ type: "auditAdvisory", data: { advisory } }));
  lines.push({ type: "auditSummary", data: { vulnerabilities: { high: summaryHigh, critical: 0 } } });
  writeFileSync(input, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return spawnSync(process.execPath, [join(__dirname, "audit_gate.js"), input, scope], { encoding: "utf8" });
}

function braces(overrides = {}) {
  return {
    module_name: "braces",
    severity: "high",
    github_advisory_id: "GHSA-vfj7-8cjw-p6xm",
    patched_versions: "<0.0.0",
    findings: [{ paths: ["solidity-coverage>mocha>chokidar>braces"] }],
    ...overrides,
  };
}

test("accepts the documented unpatched braces advisory under solidity-coverage in the full scope", () => {
  assert.equal(runAdvisories("full", 1, [braces()]).status, 0);
});

test("rejects the braces exception in the production scope", () => {
  assert.equal(runAdvisories("production", 1, [braces()]).status, 1);
});

test("rejects braces reached through any other path", () => {
  const other = braces({ findings: [{ paths: ["solidity-coverage>x>braces", "ethers>braces"] }] });
  assert.equal(runAdvisories("full", 1, [other]).status, 1);
});

test("rejects braces once a patched version exists", () => {
  assert.equal(runAdvisories("full", 1, [braces({ patched_versions: ">=3.0.4" })]).status, 1);
});

test("rejects a different high advisory on an approved path", () => {
  assert.equal(runAdvisories("full", 1, [braces({ github_advisory_id: "GHSA-other" })]).status, 1);
});

test("rejects when the summary counts more high advisories than the records show", () => {
  assert.equal(runAdvisories("full", 2, [braces()]).status, 1);
});
