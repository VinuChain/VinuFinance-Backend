#!/usr/bin/env node

/*
 * Dependency-audit policy gate.
 *
 * Yarn 1 exits non-zero when advisories are present, so CI captures its JSONL
 * output in the runner's private temporary directory and invokes this script.
 * The gate rejects every critical or high advisory except the narrow approvals below. Lower severities remain
 * visible in the emitted report and are not hidden.
 */

const fs = require("fs");

// Narrow, documented exceptions (see docs/dependency-audit.md). An entry only
// applies while the registry still reports no patched release, in the full
// toolchain scope, and for dependency paths under the named parent. Anything
// else, including a newly patched braces, fails the gate again.
const APPROVED_HIGH = [
  {
    advisory: "GHSA-vfj7-8cjw-p6xm",
    module: "braces",
    scope: "full",
    pathPrefix: "solidity-coverage>",
    reason: "stack-exhaustion DoS in dev-only coverage tooling over trusted globs; no patched braces release exists",
  },
];

function approvalFor(advisory, findingPath) {
  return APPROVED_HIGH.find(
    (entry) =>
      entry.scope === scope &&
      entry.advisory === advisory.github_advisory_id &&
      entry.module === advisory.module_name &&
      advisory.patched_versions === "<0.0.0" &&
      findingPath.startsWith(entry.pathPrefix)
  );
}

const inputFile = process.argv[2];
const scope = process.argv[3] || "full";

function readAuditJsonl(file) {
  let source;
  try {
    source = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  } catch (error) {
    throw new Error(`could not read ${file || "stdin"}: ${error.message}`);
  }
  return source
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`invalid JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

function advisoryRecords(records) {
  return records
    .filter((record) => record.type === "auditAdvisory")
    .map((record) => record.data.advisory)
    .filter(Boolean);
}

let records;
try {
  records = readAuditJsonl(inputFile);
} catch (error) {
  console.error(`[audit-gate] ${error.message}`);
  process.exit(1);
}

const summaryRecord = records.find((record) => record.type === "auditSummary");
if (!summaryRecord) {
  console.error("[audit-gate] no auditSummary record found; audit likely failed before producing a report");
  process.exit(1);
}

const vulnerabilities = summaryRecord.data && summaryRecord.data.vulnerabilities;
if (
  !vulnerabilities ||
  !Number.isInteger(vulnerabilities.high) ||
  vulnerabilities.high < 0 ||
  !Number.isInteger(vulnerabilities.critical) ||
  vulnerabilities.critical < 0
) {
  console.error("[audit-gate] auditSummary has missing or invalid high/critical counts");
  process.exit(1);
}

const advisories = advisoryRecords(records);
const critical = advisories.filter((advisory) => advisory.severity === "critical");
const high = advisories.filter((advisory) => advisory.severity === "high");
const unapprovedHigh = [];
const approvedHigh = [];

for (const advisory of high) {
  const paths = (advisory.findings || []).flatMap((finding) => finding.paths || []);
  if (paths.length === 0) {
    unapprovedHigh.push({ module: advisory.module_name, patched: advisory.patched_versions, paths: [], reason: "advisory has no dependency path to review" });
    continue;
  }
  for (const findingPath of paths) {
    const approval = approvalFor(advisory, findingPath);
    if (approval) {
      approvedHigh.push({ module: advisory.module_name, path: findingPath, reason: approval.reason });
      continue;
    }
    unapprovedHigh.push({ module: advisory.module_name, patched: advisory.patched_versions, path: findingPath });
  }
}

const result = {
  pass:
    vulnerabilities.critical === 0 &&
    vulnerabilities.high === high.length &&
    critical.length === 0 &&
    unapprovedHigh.length === 0,
  scope,
  policy: {
    critical: "zero allowed",
    high: "zero allowed except approved unpatched dev-tool paths",
    lowerSeverities: "reported, not suppressed",
  },
  summary: summaryRecord.data,
  approvedHigh,
  critical: critical.map((advisory) => ({ module: advisory.module_name, patched: advisory.patched_versions })),
  unapprovedHigh,
};

console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
