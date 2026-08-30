#!/usr/bin/env node

/*
 * Compiler/toolchain gate for the two supported build paths.
 *
 * Hardhat build-info is the authoritative record of the Solidity compiler
 * input. Foundry's declarative settings are checked against its resolved
 * `forge config --json` output, then the generated artifacts are compared.
 * Artifacts and canonical ABIs must match across both pipelines. Metadata-
 * stripped hashes are also reported for concise executable-code evidence.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const expected = {
  solc: "0.8.36",
  evmVersion: "cancun",
  optimizer: true,
  optimizerRuns: 200,
  yul: true,
  bytecodeHash: "none",
};
const sizeLimits = {
  runtimeBytes: 24576,
  initBytes: 49152,
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

function readResolvedForgeConfig() {
  try {
    const output = execFileSync("forge", ["config", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(output);
  } catch (error) {
    fail("could not read resolved forge config from `forge config --json`: " + error.message);
  }
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

function bytecodeBytes(bytecode, label) {
  const normalized = normalizeBytecode(bytecode);
  assert(/^[0-9a-f]*$/.test(normalized) && normalized.length % 2 === 0, `${label}: invalid bytecode hex`);
  return Buffer.from(normalized, "hex");
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

// Solidity ABI JSON contains source-level names and internalType annotations
// that are not part of the canonical ABI. Normalize only the selector/event
// shape so Hardhat and Foundry can be compared without tool-specific noise.
function canonicalType(parameter) {
  const type = parameter.type || "";
  if (!type.startsWith("tuple")) return type;
  return `(${(parameter.components || []).map(canonicalType).join(",")})${type.slice("tuple".length)}`;
}

function canonicalParameter(parameter, includeIndexed) {
  const result = { type: canonicalType(parameter) };
  if (includeIndexed && parameter.indexed !== undefined) result.indexed = Boolean(parameter.indexed);
  return result;
}

function canonicalAbi(abi) {
  return abi
    .map((item) => {
      const result = { type: item.type };
      if (item.name !== undefined) result.name = item.name;
      if (item.stateMutability !== undefined) result.stateMutability = item.stateMutability;
      if (item.anonymous !== undefined) result.anonymous = Boolean(item.anonymous);
      if (item.inputs) result.inputs = item.inputs.map((parameter) => canonicalParameter(parameter, item.type === "event"));
      if (item.outputs) result.outputs = item.outputs.map((parameter) => canonicalParameter(parameter, false));
      return result;
    })
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function canonicalFunctionSignatures(abi) {
  return new Set(
    abi
      .filter((item) => item.type === "function")
      .map((item) => `${item.name}(${(item.inputs || []).map(canonicalType).join(",")})`),
  );
}

// These methods are security/accounting surface, so checking ABI equality is
// not enough: both build paths must expose them explicitly.
const requiredFunctions = {
  BasePool: [
    "getCurrentLpShares(address)",
    "pendingRevenue(address)",
    "pendingRewardDebt(address)",
    "flushPendingRevenue(address,uint256)",
    "retryPendingReward(address,uint256)",
  ],
  Controller: [
    "requestTokenDistribution(address,uint128,uint32,uint96)",
    "requestTokenDistributionExact(address,uint256)",
  ],
};

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
  assert(
    settings.metadata && settings.metadata.bytecodeHash === expected.bytecodeHash,
    `${file}: metadata bytecode hash does not match`,
  );
}

const foundryToml = fs.readFileSync(path.join(root, "foundry.toml"), "utf8");
assert(readTomlString(foundryToml, "solc") === expected.solc, "foundry.toml solc does not match");
assert(readTomlString(foundryToml, "evm_version") === expected.evmVersion, "foundry.toml evm_version does not match");
assert(readTomlBoolean(foundryToml, "optimizer"), "foundry.toml optimizer must be enabled");
assert(readTomlNumber(foundryToml, "optimizer_runs") === expected.optimizerRuns, "foundry.toml optimizer_runs does not match");
assert(/optimizer_details\s*=\s*\{[^}]*\byul\s*=\s*true\b[^}]*\}/s.test(foundryToml), "foundry.toml optimizer_details.yul must be true");
assert(
  readTomlString(foundryToml, "bytecode_hash") === expected.bytecodeHash,
  "foundry.toml bytecode_hash does not match",
);

const forgeConfig = readResolvedForgeConfig();
assert(forgeConfig.solc === expected.solc, `resolved Foundry solc does not match ${expected.solc}`);
assert(forgeConfig.evm_version === expected.evmVersion, `resolved Foundry evm_version does not match ${expected.evmVersion}`);
assert(forgeConfig.optimizer === expected.optimizer, "resolved Foundry optimizer must be enabled");
assert(forgeConfig.optimizer_runs === expected.optimizerRuns, "resolved Foundry optimizer_runs does not match");
assert(forgeConfig.optimizer_details && forgeConfig.optimizer_details.yul === expected.yul, "resolved Foundry optimizer_details.yul must be true");
assert(forgeConfig.bytecode_hash === expected.bytecodeHash, "resolved Foundry bytecode_hash does not match");

const contracts = ["BasePool", "Controller", "MultiClaim", "EmergencyWithdrawal"];
const comparisons = [];
for (const name of contracts) {
  const hardhat = readJson(path.join("artifacts", "contracts", `${name}.sol`, `${name}.json`));
  const foundry = readJson(path.join("out", `${name}.sol`, `${name}.json`));
  const hardhatInitCode = bytecodeBytes(hardhat.bytecode, `${name} Hardhat init`);
  const foundryInitCode = bytecodeBytes(foundry.bytecode.object, `${name} Foundry init`);
  const hardhatRuntimeCode = bytecodeBytes(hardhat.deployedBytecode, `${name} Hardhat runtime`);
  const foundryRuntimeCode = bytecodeBytes(foundry.deployedBytecode.object, `${name} Foundry runtime`);
  assert(hardhatRuntimeCode.length <= sizeLimits.runtimeBytes, `${name}: runtime bytecode exceeds ${sizeLimits.runtimeBytes} bytes`);
  assert(hardhatInitCode.length <= sizeLimits.initBytes, `${name}: init bytecode exceeds ${sizeLimits.initBytes} bytes`);
  assert(foundryRuntimeCode.length <= sizeLimits.runtimeBytes, `${name}: Foundry runtime bytecode exceeds ${sizeLimits.runtimeBytes} bytes`);
  assert(foundryInitCode.length <= sizeLimits.initBytes, `${name}: Foundry init bytecode exceeds ${sizeLimits.initBytes} bytes`);
  assert(
    normalizeBytecode(hardhat.bytecode) === normalizeBytecode(foundry.bytecode.object),
    `${name}: exact init bytecode differs`,
  );
  assert(
    normalizeBytecode(hardhat.deployedBytecode) === normalizeBytecode(foundry.deployedBytecode.object),
    `${name}: exact deployed runtime bytecode differs`,
  );
  const hardhatInit = stripMetadata(hardhat.bytecode);
  const foundryInit = stripMetadata(foundry.bytecode.object);
  const hardhatRuntime = stripMetadata(hardhat.deployedBytecode);
  const foundryRuntime = stripMetadata(foundry.deployedBytecode.object);
  assert(hardhatInit.equals(foundryInit), `${name}: metadata-stripped init bytecode differs`);
  assert(hardhatRuntime.equals(foundryRuntime), `${name}: metadata-stripped deployed runtime bytecode differs`);
  const hardhatAbi = canonicalAbi(hardhat.abi || []);
  const foundryAbi = canonicalAbi(foundry.abi || []);
  assert(JSON.stringify(hardhatAbi) === JSON.stringify(foundryAbi), `${name}: canonical ABI differs`);
  const hardhatFunctions = canonicalFunctionSignatures(hardhat.abi || []);
  const foundryFunctions = canonicalFunctionSignatures(foundry.abi || []);
  for (const signature of requiredFunctions[name] || []) {
    assert(hardhatFunctions.has(signature), `${name}: Hardhat ABI is missing ${signature}`);
    assert(foundryFunctions.has(signature), `${name}: Foundry ABI is missing ${signature}`);
  }
  comparisons.push({
    contract: name,
    initCodeBytes: hardhatInitCode.length,
    initBytes: hardhatInit.length,
    hardhatInitSha256: shortHash(hardhatInit),
    foundryInitSha256: shortHash(foundryInit),
    runtimeCodeBytes: hardhatRuntimeCode.length,
    runtimeBytes: hardhatRuntime.length,
    hardhatSha256: shortHash(hardhatRuntime),
    foundrySha256: shortHash(foundryRuntime),
    abiEntries: hardhatAbi.length,
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
      bytecodeHash: forgeConfig.bytecode_hash,
    },
  },
  deployedRuntime: comparisons,
  sizeLimits,
}, null, 2));
