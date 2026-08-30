#!/usr/bin/env node

/*
 * Dependency-audit policy gate.
 *
 * Yarn 1 exits non-zero when advisories are present, so CI captures its JSONL
 * output in the runner's private temporary directory and invokes this script.
 * The gate rejects every critical advisory and every high advisory that is not
 * one of the explicitly documented, dev-tool-only/range-constrained paths.
 * Lower severities remain visible in the emitted report and are not hidden.
 */

const fs = require("fs");

const inputFile = process.argv[2];
const scope = process.argv[3] || "full";

const allowedHigh = [
  {
    module: "serialize-javascript",
    patched: ">=7.0.3",
    paths: ["mocha>serialize-javascript", "hardhat>mocha>serialize-javascript"],
    reason: "Hardhat 2 / Mocha 11 currently declare serialize-javascript ^6; no compatible patched release is published.",
  },
  {
    module: "tmp",
    patched: ">=0.2.6",
    paths: ["hardhat>solc>tmp"],
    reason: "Hardhat 2.29.1's solc dependency declares tmp 0.0.33; upgrading it requires an incompatible upstream range override.",
  },
  {
    module: "adm-zip",
    patched: ">=0.6.0",
    paths: ["hardhat>adm-zip"],
    reason: "Hardhat 2.29.1 declares adm-zip ^0.4.16; the patched 0.6 line is outside that range and is not API-equivalent by declaration.",
  },
  {
    module: "undici",
    patched: ">=6.24.0",
    paths: ["@nomicfoundation/hardhat-verify>undici"],
    reason: "The official Hardhat 2 verification plugin declares undici ^5.14; the patched 6.x line is outside its declared range.",
  },
  {
    module: "undici",
    patched: ">=6.27.0",
    paths: ["@nomicfoundation/hardhat-verify>undici"],
    reason: "The official Hardhat 2 verification plugin declares undici ^5.14; the patched 6.x line is outside its declared range.",
  },
  {
    module: "ws",
    patched: ">=8.21.0",
    paths: ["@ethersproject/providers>ws", "ethers>@ethersproject/providers>ws"],
    reason: "Ethers 5.8's provider package pins ws 8.18.0 exactly; no compatible patched release is available without violating its declared range.",
  },
];

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

function matchingException(advisory, findingPath) {
  return allowedHigh.find(
    (exception) =>
      exception.module === advisory.module_name &&
      exception.patched === advisory.patched_versions &&
      exception.paths.includes(findingPath),
  );
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
    const exception = matchingException(advisory, findingPath);
    if (!exception) {
      unapprovedHigh.push({ module: advisory.module_name, patched: advisory.patched_versions, path: findingPath });
    } else {
      approvedHigh.push({ module: advisory.module_name, patched: advisory.patched_versions, path: findingPath, reason: exception.reason });
    }
  }
}

const result = {
  pass: critical.length === 0 && unapprovedHigh.length === 0,
  scope,
  policy: {
    critical: "zero allowed",
    high: "only exact entries in this script's allowlist are accepted",
    lowerSeverities: "reported, not suppressed",
  },
  summary: summaryRecord.data,
  approvedHigh,
  critical: critical.map((advisory) => ({ module: advisory.module_name, patched: advisory.patched_versions })),
  unapprovedHigh,
};

console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exit(1);
