#!/usr/bin/env node

/*
 * Dependency-audit policy gate.
 *
 * Yarn 1 exits non-zero when advisories are present, so CI captures its JSONL
 * output in the runner's private temporary directory and invokes this script.
 * The gate rejects every critical or high advisory. Lower severities remain
 * visible in the emitted report and are not hidden.
 */

const fs = require("fs");

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

for (const advisory of high) {
  const paths = (advisory.findings || []).flatMap((finding) => finding.paths || []);
  if (paths.length === 0) {
    unapprovedHigh.push({ module: advisory.module_name, patched: advisory.patched_versions, paths: [], reason: "advisory has no dependency path to review" });
    continue;
  }
  for (const findingPath of paths) {
    unapprovedHigh.push({ module: advisory.module_name, patched: advisory.patched_versions, path: findingPath });
  }
}

const result = {
  pass:
    vulnerabilities.critical === 0 &&
    vulnerabilities.high === 0 &&
    critical.length === 0 &&
    unapprovedHigh.length === 0,
  scope,
  policy: {
    critical: "zero allowed",
    high: "zero allowed",
    lowerSeverities: "reported, not suppressed",
  },
  summary: summaryRecord.data,
  approvedHigh: [],
  critical: critical.map((advisory) => ({ module: advisory.module_name, patched: advisory.patched_versions })),
  unapprovedHigh,
};

console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
