#!/usr/bin/env node

/*
 * Compiler/toolchain gate for the two supported build paths.
 *
 * Hardhat build-info is the authoritative record of the Solidity compiler
 * input. Foundry's resolved configuration is represented by foundry.toml and
 * is exercised immediately before this script by `forge build --force`.
 * Runtime bytecode is compared after removing the compiler metadata trailer;
 * metadata contains source-path hashes that differ between the two tools.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const expected = {
  solc: "0.8.36",
  evmVersion: "cancun",
  optimizer: true,
  optimizerRuns: 200,
  yul: true,
};

function fail(message) {
  throw new Error(`[compiler-alignment] ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function readJson(file) {
  const resolved = path.isAbsolute(file) ? file : path.join(root, file);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function readTomlValue(source, key) {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*(?:#.*)?$`, "m"));
  return match && match[1];
}

function readTomlString(source, key) {
  const value = readTomlValue(source, key);
  return value && value.replace(/^"|"$/g, "");
}

function readTomlBoolean(source, key) {
  return readTomlValue(source, key) === "true";
}

function readTomlNumber(source, key) {
  const value = readTomlValue(source, key);
  return value === undefined ? undefined : Number(value);
}

function normalizeBytecode(bytecode) {
  return bytecode.replace(/^0x/, "").toLowerCase();
}

function stripMetadata(bytecode) {
  const bytes = Buffer.from(normalizeBytecode(bytecode), "hex");
  assert(bytes.length >= 2, "bytecode is too short to contain metadata length");
  const metadataLength = bytes.readUInt16BE(bytes.length - 2);
  assert(metadataLength + 2 <= bytes.length, "invalid Solidity metadata length");
  return bytes.subarray(0, bytes.length - metadataLength - 2);
}

function shortHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

const buildInfoDir = path.join(root, "artifacts", "build-info");
const buildInfoFiles = fs.existsSync(buildInfoDir)
  ? fs.readdirSync(buildInfoDir).filter((file) => file.endsWith(".json")).sort()
  : [];
assert(buildInfoFiles.length > 0, "no Hardhat build-info files found; run hardhat compile first");

for (const file of buildInfoFiles) {
  const buildInfo = readJson(path.join("artifacts", "build-info", file));
  const settings = buildInfo.input && buildInfo.input.settings;
  assert(buildInfo.solcVersion === expected.solc, `${file}: expected solc ${expected.solc}, got ${buildInfo.solcVersion}`);
  assert(settings && settings.evmVersion === expected.evmVersion, `${file}: expected evmVersion ${expected.evmVersion}`);
  assert(
    settings.optimizer &&
      settings.optimizer.enabled === expected.optimizer &&
      settings.optimizer.runs === expected.optimizerRuns &&
      settings.optimizer.details &&
      settings.optimizer.details.yul === expected.yul,
    `${file}: optimizer settings do not match ${JSON.stringify(expected)}`,
  );
}

const foundryToml = fs.readFileSync(path.join(root, "foundry.toml"), "utf8");
assert(readTomlString(foundryToml, "solc") === expected.solc, "foundry.toml solc does not match");
assert(readTomlString(foundryToml, "evm_version") === expected.evmVersion, "foundry.toml evm_version does not match");
assert(readTomlBoolean(foundryToml, "optimizer"), "foundry.toml optimizer must be enabled");
assert(readTomlNumber(foundryToml, "optimizer_runs") === expected.optimizerRuns, "foundry.toml optimizer_runs does not match");
assert(/optimizer_details\s*=\s*\{[^}]*\byul\s*=\s*true\b[^}]*\}/s.test(foundryToml), "foundry.toml optimizer_details.yul must be true");

const forgeConfigFile = process.argv[2] || process.env.FOUNDRY_CONFIG_JSON;
assert(forgeConfigFile, "pass the output of `forge config --json` as the first argument");
let forgeConfig;
try {
  forgeConfig = readJson(forgeConfigFile);
} catch (error) {
  fail(`could not read resolved forge config ${forgeConfigFile}: ${error.message}`);
}
assert(forgeConfig.solc === expected.solc, `resolved Foundry solc does not match ${expected.solc}`);
assert(forgeConfig.evm_version === expected.evmVersion, `resolved Foundry evm_version does not match ${expected.evmVersion}`);
assert(forgeConfig.optimizer === expected.optimizer, "resolved Foundry optimizer must be enabled");
assert(forgeConfig.optimizer_runs === expected.optimizerRuns, "resolved Foundry optimizer_runs does not match");
assert(forgeConfig.optimizer_details && forgeConfig.optimizer_details.yul === expected.yul, "resolved Foundry optimizer_details.yul must be true");

const contracts = ["BasePool", "Controller", "MultiClaim", "EmergencyWithdrawal"];
const comparisons = [];
for (const name of contracts) {
  const hardhat = readJson(path.join("artifacts", "contracts", `${name}.sol`, `${name}.json`));
  const foundry = readJson(path.join("out", `${name}.sol`, `${name}.json`));
  const hardhatInit = stripMetadata(hardhat.bytecode);
  const foundryInit = stripMetadata(foundry.bytecode.object);
  const hardhatRuntime = stripMetadata(hardhat.deployedBytecode);
  const foundryRuntime = stripMetadata(foundry.deployedBytecode.object);
  assert(hardhatInit.equals(foundryInit), `${name}: metadata-stripped init bytecode differs`);
  assert(hardhatRuntime.equals(foundryRuntime), `${name}: metadata-stripped deployed runtime bytecode differs`);
  comparisons.push({
    contract: name,
    initBytes: hardhatInit.length,
    hardhatInitSha256: shortHash(hardhatInit),
    foundryInitSha256: shortHash(foundryInit),
    runtimeBytes: hardhatRuntime.length,
    hardhatSha256: shortHash(hardhatRuntime),
    foundrySha256: shortHash(foundryRuntime),
  });
}

console.log(JSON.stringify({
  pass: true,
  settings: {
    hardhat: expected,
    foundry: {
      solc: forgeConfig.solc,
      evmVersion: forgeConfig.evm_version,
      optimizer: forgeConfig.optimizer,
      optimizerRuns: forgeConfig.optimizer_runs,
      yul: forgeConfig.optimizer_details.yul,
    },
  },
  deployedRuntime: comparisons,
}, null, 2));
