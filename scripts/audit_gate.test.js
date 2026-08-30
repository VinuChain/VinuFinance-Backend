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
