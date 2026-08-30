#!/usr/bin/env node

/*
 * Read-only reconciliation for the immutable VinuChain legacy deployment.
 *
 * This file intentionally has no signer dependency. It uses the existing
 * ethers runtime dependency and read-only JSON-RPC calls, without a wallet or
 * frontend runtime.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { utils: ethersUtils } = require("ethers");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = resolve(SCRIPT_DIR, "../deployments/vinuchain-legacy.json");
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const EVENT_CHUNK_SIZE = 100_000;
const MAX_EVENT_CHUNKS = 1_000;
const NEW_SUB_POOL_INTERFACE = new ethersUtils.Interface([
  "event NewSubPool(address loanCcyToken,address collCcyToken,uint256 loanTenor,uint256 maxLoanPerColl,uint256 r1,uint256 r2,uint256 liquidityBnd1,uint256 liquidityBnd2,uint256 minLoan,uint256 creatorFee,address poolController,uint96 rewardCoefficient)",
]);
const NEW_SUB_POOL_TOPIC = NEW_SUB_POOL_INTERFACE.getEventTopic("NewSubPool");

function keccak256(input) {
  return ethersUtils.keccak256(input);
}

function stripHex(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]*$/i.test(value) || value.length % 2 !== 0) {
    throw new Error(`Expected an even-length 0x hex value, received ${String(value).slice(0, 80)}`);
  }
  return value.slice(2).toLowerCase();
}

function hexBytes(value) {
  return ethersUtils.arrayify(value);
}

function word(value) {
  const number = BigInt(value);
  if (number < 0n || number >= (1n << 256n)) throw new Error("ABI uint256 out of range");
  return number.toString(16).padStart(64, "0");
}

function addressWord(value) {
  if (!ADDRESS_RE.test(value)) throw new Error(`Invalid address: ${value}`);
  return `${"0".repeat(24)}${value.slice(2).toLowerCase()}`;
}

function selector(signature) {
  return keccak256(Buffer.from(signature, "ascii")).slice(2, 10);
}

function callData(signature, args = []) {
  return `0x${selector(signature)}${args.map((arg) => (arg.type === "address" ? addressWord(arg.value) : word(arg.value))).join("")}`;
}

function decodeWord(data, index = 0) {
  const value = stripHex(data);
  const start = index * 64;
  if (value.length < start + 64) throw new Error(`Short ABI response for word ${index}`);
  return BigInt(`0x${value.slice(start, start + 64)}`);
}

function decodeAddress(data, index = 0) {
  const value = decodeWord(data, index).toString(16).padStart(64, "0");
  return `0x${value.slice(-40)}`;
}

function decodeBool(data, index = 0) {
  return decodeWord(data, index) !== 0n;
}

function blockTag(value) {
  if (value === undefined) return "latest";
  if (!/^\d+$/.test(value)) throw new Error(`Block must be a non-negative decimal integer: ${value}`);
  return `0x${BigInt(value).toString(16)}`;
}

function resolveReadTag(requestedBlock, resolvedBlock) {
  const selected = requestedBlock === undefined ? resolvedBlock : blockTag(requestedBlock);
  if (selected === "latest") throw new Error("Read tag must be a resolved block number");
  return selected;
}

function safeRpcOrigin(url) {
  return (url instanceof URL ? url : new URL(url)).origin;
}

function parseArgs(argv) {
  const args = { json: false, manifest: DEFAULT_MANIFEST };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") args.json = true;
    else if (value === "--self-check") args.selfCheck = true;
    else if (value === "--help" || value === "-h") args.help = true;
    else if (value === "--rpc-url" || value === "--block" || value === "--manifest" || value === "--max-loans") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${value} needs a value`);
      index += 1;
      if (value === "--rpc-url") args.rpcUrl = next;
      if (value === "--block") args.block = next;
      if (value === "--manifest") args.manifest = resolve(process.cwd(), next);
      if (value === "--max-loans") args.maxLoans = next;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function loadManifest(path = DEFAULT_MANIFEST) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) throw new Error("Unsupported manifest schemaVersion");
  if (manifest.network?.chainId !== 207) throw new Error("Manifest chainId must be 207");
  if (!Number.isInteger(manifest.network?.observedBlock) || manifest.network.observedBlock <= 0) throw new Error("Manifest observedBlock must be a positive integer");
  if (!Number.isInteger(manifest.network?.observedBlockTimestamp) || manifest.network.observedBlockTimestamp <= 0) throw new Error("Manifest observedBlockTimestamp must be a positive integer");
  if (!Number.isInteger(manifest.network?.eventScanStartBlock) || manifest.network.eventScanStartBlock < 0) throw new Error("Manifest eventScanStartBlock must be a non-negative integer");
  if (!Array.isArray(manifest.pools) || manifest.pools.length !== 10) throw new Error("Manifest must list exactly ten pools");
  const addresses = [
    ...Object.values(manifest.contracts ?? {}).map((item) => item.address),
    ...Object.values(manifest.tokens ?? {}).map((item) => item.address),
    ...manifest.pools.map((item) => item.address),
  ];
  if (addresses.some((address) => !ADDRESS_RE.test(address))) throw new Error("Manifest contains an invalid address");
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length) throw new Error("Manifest contains duplicate addresses");
  for (const pool of manifest.pools) {
    if (!pool.id || !pool.config || !pool.loanToken || !pool.collateralToken) throw new Error(`Incomplete pool manifest: ${pool.id ?? "unknown"}`);
    for (const key of ["loanTenor", "maxLoanPerColl", "r1", "r2", "liquidityBnd1", "liquidityBnd2", "minLoan", "creatorFee", "minLiquidity", "rewardCoefficient"]) {
      if (pool.config[key] === undefined) throw new Error(`Pool ${pool.id} is missing config.${key}`);
    }
  }
  return manifest;
}

class RpcClient {
  constructor(url, timeoutMs = 20_000) {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("RPC URL must be an https/http URL without credentials");
    this.requestUrl = parsed.toString();
    this.url = safeRpcOrigin(parsed);
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  async request(method, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.requestUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.error) throw new Error(`RPC ${payload.error.code}: ${payload.error.message}`);
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  call(address, signature, args, tag) {
    return this.request("eth_call", [{ to: address, data: callData(signature, args) }, tag]);
  }
}

async function readCall(rpc, address, signature, args, tag) {
  return rpc.call(address, signature, args, tag);
}

async function readUint(rpc, address, signature, args, tag) {
  return decodeWord(await readCall(rpc, address, signature, args, tag));
}

async function readAddress(rpc, address, signature, args, tag) {
  return decodeAddress(await readCall(rpc, address, signature, args, tag));
}

async function readBool(rpc, address, signature, args, tag) {
  return decodeBool(await readCall(rpc, address, signature, args, tag));
}

function sameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function addFinding(findings, severity, code, scope, expected, actual) {
  findings.push({ severity, code, scope, expected, actual });
}

function compare(findings, scope, expected, actual, code = "RECONCILIATION_MISMATCH") {
  const expectedText = typeof expected === "bigint" ? expected.toString() : expected;
  const actualText = typeof actual === "bigint" ? actual.toString() : actual;
  const matches = typeof expected === "string" && ADDRESS_RE.test(expected) && typeof actual === "string" && ADDRESS_RE.test(actual)
    ? sameAddress(expected, actual)
    : String(expectedText) === String(actualText);
  if (!matches) addFinding(findings, "error", code, scope, expectedText, actualText);
}

async function readToken(rpc, token, tag, findings) {
  const code = await rpc.request("eth_getCode", [token.address, tag]);
  if (code === "0x") addFinding(findings, "error", "MISSING_CODE", `token.${token.symbol}.bytecode`, "deployed bytecode", "0x");
  const decimalsData = await readCall(rpc, token.address, "decimals()", [], tag);
  if (stripHex(decimalsData).length < 64) throw new Error(`Empty decimals() response for ${token.symbol} at ${token.address}`);
  const actual = {
    address: token.address,
    runtimeBytes: hexBytes(code).length,
    runtimeKeccak: keccak256(hexBytes(code)),
    decimals: Number(decodeWord(decimalsData)),
  };
  compare(findings, `token.${token.symbol}.runtimeBytes`, token.runtimeBytes, actual.runtimeBytes);
  compare(findings, `token.${token.symbol}.runtimeKeccak`, token.runtimeKeccak.toLowerCase(), actual.runtimeKeccak);
  compare(findings, `token.${token.symbol}.decimals`, token.decimals, actual.decimals);
  return actual;
}

async function readRuntime(rpc, item, scope, tag, findings) {
  const code = await rpc.request("eth_getCode", [item.address, tag]);
  const actual = { runtimeBytes: hexBytes(code).length, runtimeKeccak: keccak256(hexBytes(code)) };
  if (code === "0x") addFinding(findings, "error", "MISSING_CODE", `${scope}.bytecode`, "deployed bytecode", "0x");
  compare(findings, `${scope}.runtimeBytes`, item.runtimeBytes, actual.runtimeBytes);
  compare(findings, `${scope}.runtimeKeccak`, item.runtimeKeccak.toLowerCase(), actual.runtimeKeccak);
  return actual;
}

function textValue(value) {
  return typeof value === "string" ? value : value.toString();
}

async function readNewSubPoolEvents(rpc, manifest, toBlockHex, findings) {
  const fromBlock = BigInt(manifest.network.eventScanStartBlock);
  const toBlock = BigInt(toBlockHex);
  if (fromBlock > toBlock) {
    addFinding(findings, "error", "EVENT_SCAN_RANGE_INVALID", "events.range", `<= ${toBlock}`, fromBlock);
    return { fromBlock: Number(fromBlock), toBlock: Number(toBlock), chunkSize: EVENT_CHUNK_SIZE, chunks: 0, records: [] };
  }

  const logs = [];
  let chunks = 0;
  for (let start = fromBlock; start <= toBlock; start += BigInt(EVENT_CHUNK_SIZE)) {
    chunks += 1;
    if (chunks > MAX_EVENT_CHUNKS) {
      addFinding(findings, "error", "EVENT_SCAN_CAP_EXCEEDED", "events.chunks", `<= ${MAX_EVENT_CHUNKS}`, chunks);
      break;
    }
    const end = start + BigInt(EVENT_CHUNK_SIZE - 1) < toBlock ? start + BigInt(EVENT_CHUNK_SIZE - 1) : toBlock;
    const result = await rpc.request("eth_getLogs", [{
      fromBlock: blockTag(start.toString()),
      toBlock: blockTag(end.toString()),
      topics: [NEW_SUB_POOL_TOPIC],
    }]);
    if (!Array.isArray(result)) throw new Error("eth_getLogs returned a non-array result");
    logs.push(...result);
  }

  const expected = new Map(manifest.pools.map((pool) => [pool.address.toLowerCase(), pool]));
  const controllerAddress = manifest.contracts.controller.address;
  const seen = new Map();
  const records = [];
  for (const log of logs) {
    let parsed;
    try {
      parsed = NEW_SUB_POOL_INTERFACE.parseLog({ topics: log.topics, data: log.data });
    } catch (error) {
      addFinding(findings, "error", "EVENT_DECODE_FAILED", "events.log", "NewSubPool ABI", error.message);
      continue;
    }
    const args = parsed.args;
    const event = {
      pool: String(log.address).toLowerCase(),
      block: Number(BigInt(log.blockNumber)),
      transactionHash: String(log.transactionHash).toLowerCase(),
      loanToken: String(args.loanCcyToken).toLowerCase(),
      collateralToken: String(args.collCcyToken).toLowerCase(),
      loanTenor: textValue(args.loanTenor),
      maxLoanPerColl: textValue(args.maxLoanPerColl),
      r1: textValue(args.r1),
      r2: textValue(args.r2),
      liquidityBnd1: textValue(args.liquidityBnd1),
      liquidityBnd2: textValue(args.liquidityBnd2),
      minLoan: textValue(args.minLoan),
      creatorFee: textValue(args.creatorFee),
      poolController: String(args.poolController).toLowerCase(),
      rewardCoefficient: textValue(args.rewardCoefficient),
    };
    if (!sameAddress(event.poolController, controllerAddress)) continue;
    const address = event.pool;
    const pool = expected.get(address);
    if (!pool) {
      addFinding(findings, "error", "UNEXPECTED_NEW_SUBPOOL", `events.${address}`, "manifest pool", event.pool);
      records.push(event);
      continue;
    }
    const count = (seen.get(address) ?? 0) + 1;
    seen.set(address, count);
    if (count > 1) addFinding(findings, "error", "DUPLICATE_NEW_SUBPOOL", `events.${pool.id}`, 1, count);

    compare(findings, `${pool.id}.event.block`, pool.creationBlock, event.block, "NEW_SUBPOOL_MISMATCH");
    compare(findings, `${pool.id}.event.transactionHash`, pool.creationTxHash.toLowerCase(), event.transactionHash, "NEW_SUBPOOL_MISMATCH");
    compare(findings, `${pool.id}.event.loanToken`, manifest.tokens[pool.loanToken].address, event.loanToken, "NEW_SUBPOOL_MISMATCH");
    compare(findings, `${pool.id}.event.collateralToken`, manifest.tokens[pool.collateralToken].address, event.collateralToken, "NEW_SUBPOOL_MISMATCH");
    for (const key of ["loanTenor", "maxLoanPerColl", "r1", "r2", "liquidityBnd1", "liquidityBnd2", "minLoan", "creatorFee", "rewardCoefficient"]) {
      compare(findings, `${pool.id}.event.${key}`, pool.config[key], event[key], "NEW_SUBPOOL_MISMATCH");
    }
    compare(findings, `${pool.id}.event.poolController`, controllerAddress, event.poolController, "NEW_SUBPOOL_MISMATCH");
    records.push(event);
  }

  if (records.length !== manifest.pools.length) addFinding(findings, "error", "NEW_SUBPOOL_INVENTORY_MISMATCH", "events.count", manifest.pools.length, records.length);
  for (const pool of manifest.pools) {
    if (!seen.has(pool.address.toLowerCase())) addFinding(findings, "error", "MISSING_NEW_SUBPOOL", `events.${pool.id}`, "one event", 0);
  }
  return {
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    chunkSize: EVENT_CHUNK_SIZE,
    chunks,
    topic: NEW_SUB_POOL_TOPIC,
    records,
  };
}

async function readPool(rpc, pool, manifest, tag, blockTimestamp, maxLoans, findings) {
  const [poolInfoData, rateData, minLiquidity, collateralDecimals, paused, loanCode] = await Promise.all([
    readCall(rpc, pool.address, "getPoolInfo()", [], tag),
    readCall(rpc, pool.address, "getRateParams()", [], tag),
    readUint(rpc, pool.address, "minLiquidity()", [], tag),
    readUint(rpc, pool.address, "collTokenDecimals()", [], tag),
    readBool(rpc, pool.address, "paused()", [], tag),
    rpc.request("eth_getCode", [pool.address, tag]),
  ]);
  const poolInfo = {
    loanToken: decodeAddress(poolInfoData, 0),
    collateralToken: decodeAddress(poolInfoData, 1),
    maxLoanPerColl: decodeWord(poolInfoData, 2),
    minLoan: decodeWord(poolInfoData, 3),
    loanTenor: decodeWord(poolInfoData, 4),
    totalLiquidity: decodeWord(poolInfoData, 5),
    totalLpShares: decodeWord(poolInfoData, 6),
    rewardCoefficient: decodeWord(poolInfoData, 7),
    nextLoanIdx: decodeWord(poolInfoData, 8),
  };
  const rate = {
    liquidityBnd1: decodeWord(rateData, 0),
    liquidityBnd2: decodeWord(rateData, 1),
    r1: decodeWord(rateData, 2),
    r2: decodeWord(rateData, 3),
  };
  const expectedLoan = manifest.tokens[pool.loanToken].address;
  const expectedCollateral = manifest.tokens[pool.collateralToken].address;
  compare(findings, `${pool.id}.loanToken`, expectedLoan, poolInfo.loanToken);
  compare(findings, `${pool.id}.collateralToken`, expectedCollateral, poolInfo.collateralToken);
  for (const key of ["maxLoanPerColl", "minLoan", "loanTenor", "rewardCoefficient"]) compare(findings, `${pool.id}.config.${key}`, pool.config[key], poolInfo[key]);
  for (const key of ["liquidityBnd1", "liquidityBnd2", "r1", "r2"]) compare(findings, `${pool.id}.config.${key}`, pool.config[key], rate[key]);
  compare(findings, `${pool.id}.config.minLiquidity`, pool.config.minLiquidity, minLiquidity);
  compare(findings, `${pool.id}.declaredCollateralDecimals`, pool.declaredCollateralDecimals, collateralDecimals);

  const expectedController = manifest.contracts.controller.address;
  const actualController = await readAddress(rpc, pool.address, "poolController()", [], tag);
  compare(findings, `${pool.id}.poolController`, expectedController, actualController);
  const whitelisted = await readBool(rpc, expectedController, "poolWhitelisted(address)", [{ type: "address", value: pool.address }], tag);
  if (!whitelisted) addFinding(findings, "error", "POOL_NOT_WHITELISTED", `${pool.id}.poolWhitelisted`, true, false);

  const actualLoanToken = Object.values(manifest.tokens).find((token) => sameAddress(token.address, poolInfo.loanToken));
  const actualCollateralToken = Object.values(manifest.tokens).find((token) => sameAddress(token.address, poolInfo.collateralToken));
  if (!actualLoanToken) addFinding(findings, "error", "UNKNOWN_LOAN_TOKEN", `${pool.id}.loanToken`, "manifest token", poolInfo.loanToken);
  if (!actualCollateralToken) addFinding(findings, "error", "UNKNOWN_COLLATERAL_TOKEN", `${pool.id}.collateralToken`, "manifest token", poolInfo.collateralToken);
  const loanBalance = await readUint(rpc, poolInfo.loanToken, "balanceOf(address)", [{ type: "address", value: pool.address }], tag);
  const collateralBalance = await readUint(rpc, poolInfo.collateralToken, "balanceOf(address)", [{ type: "address", value: pool.address }], tag);
  const tokenDecimals = actualCollateralToken?.decimals;
  if (tokenDecimals !== undefined && Number(collateralDecimals) !== tokenDecimals) {
    addFinding(findings, "warning", "DECLARED_COLLATERAL_DECIMALS_MISMATCH", `${pool.id}.collateralDecimals`, tokenDecimals, Number(collateralDecimals));
  }
  const runtimeBytes = hexBytes(loanCode).length;
  const runtimeKeccak = keccak256(hexBytes(loanCode));
  if (loanCode === "0x") addFinding(findings, "error", "MISSING_CODE", `${pool.id}.bytecode`, "deployed bytecode", "0x");
  compare(findings, `${pool.id}.runtimeBytes`, pool.runtimeBytes, runtimeBytes);
  compare(findings, `${pool.id}.runtimeKeccak`, pool.runtimeKeccak.toLowerCase(), runtimeKeccak);
  const loanCount = poolInfo.nextLoanIdx > 0n ? poolInfo.nextLoanIdx - 1n : 0n;
  if (loanCount > BigInt(maxLoans)) {
    addFinding(findings, "error", "LOAN_SCAN_CAP_EXCEEDED", `${pool.id}.loanCount`, `<= ${maxLoans}`, loanCount);
  }
  const loans = [];
  const limit = loanCount > BigInt(maxLoans) ? BigInt(maxLoans) : loanCount;
  for (let index = 1n; index <= limit; index += 1n) {
    const data = await readCall(rpc, pool.address, "loanIdxToLoanInfo(uint256)", [{ type: "uint256", value: index }], tag);
    const loan = {
      loanIdx: index.toString(),
      repayment: decodeWord(data, 0).toString(),
      collateral: decodeWord(data, 1).toString(),
      loanAmount: decodeWord(data, 2).toString(),
      totalLpShares: decodeWord(data, 3).toString(),
      expiry: Number(decodeWord(data, 4)),
      repaid: decodeBool(data, 5),
    };
    loan.borrower = await readAddress(rpc, pool.address, "loanIdxToBorrower(uint256)", [{ type: "uint256", value: index }], tag);
    const observedLoan = manifest.observedLoans?.find((item) => sameAddress(item.pool, pool.address) && String(item.loanIdx) === index.toString());
    if (observedLoan?.borrower) compare(findings, `${pool.id}.loan${index}.borrower`, observedLoan.borrower, loan.borrower, "OBSERVED_LOAN_BORROWER_MISMATCH");
    loans.push(loan);
  }
  const outstanding = loans.filter((loan) => !loan.repaid);
  const repaid = loans.filter((loan) => loan.repaid);
  const expiredUnrepaid = outstanding.filter((loan) => BigInt(loan.expiry) < blockTimestamp);
  const committedLoanAmount = outstanding.reduce((sum, loan) => sum + BigInt(loan.loanAmount), 0n);
  const settledRepayments = repaid.reduce((sum, loan) => sum + BigInt(loan.repayment), 0n);
  const defaultedCollateral = expiredUnrepaid.reduce((sum, loan) => sum + BigInt(loan.collateral), 0n);
  const activeUnrepaid = outstanding.filter((loan) => BigInt(loan.expiry) >= blockTimestamp);
  const activeCollateral = activeUnrepaid.reduce((sum, loan) => sum + BigInt(loan.collateral), 0n);
  const expiredCollateral = defaultedCollateral;
  const loanBalanceMinusAvailable = loanBalance - poolInfo.totalLiquidity;
  const scanComplete = loanCount <= BigInt(maxLoans);
  const remainingDefaultCollateral = collateralBalance - activeCollateral;
  const claimedDefaultCollateral = expiredCollateral - remainingDefaultCollateral;
  const remainingRepaymentReserve = loanBalanceMinusAvailable;
  const claimedOrReinvestedRepayments = settledRepayments - remainingRepaymentReserve;
  if (scanComplete) {
    if (collateralBalance < activeCollateral) addFinding(findings, "error", "ACTIVE_COLLATERAL_UNFUNDED", `${pool.id}.collateralBalance`, `>= ${activeCollateral}`, collateralBalance);
    if (collateralBalance > activeCollateral + expiredCollateral) addFinding(findings, "error", "COLLATERAL_BALANCE_EXCEEDS_LOAN_STATE", `${pool.id}.collateralBalance`, `<= ${activeCollateral + expiredCollateral}`, collateralBalance);
    if (loanBalanceMinusAvailable < 0n) addFinding(findings, "error", "AVAILABLE_LIQUIDITY_UNFUNDED", `${pool.id}.loanBalance`, `>= ${poolInfo.totalLiquidity}`, loanBalance);
    if (loanBalanceMinusAvailable > settledRepayments) addFinding(findings, "error", "REPAYMENT_RESERVE_EXCEEDS_SETTLEMENTS", `${pool.id}.loanBalanceMinusAvailable`, `<= ${settledRepayments}`, loanBalanceMinusAvailable);
  }
  if (tag === `0x${BigInt(manifest.network.observedBlock).toString(16)}` && pool.stateAtObservation) {
    for (const key of ["totalLiquidity", "loanTokenBalance", "totalLpShares", "nextLoanIdx"]) {
      const actual = key === "loanTokenBalance" ? loanBalance : poolInfo[key];
      compare(findings, `${pool.id}.stateAtObservation.${key}`, pool.stateAtObservation[key], actual);
    }
  }
  return {
    id: pool.id,
    address: pool.address,
    runtimeBytes,
    runtimeKeccak,
    config: { ...poolInfo, ...rate, minLiquidity, collateralDecimals, poolController: actualController, whitelisted, paused },
    balances: { loanTokenAddress: poolInfo.loanToken, collateralTokenAddress: poolInfo.collateralToken, loanToken: loanBalance.toString(), collateralToken: collateralBalance.toString(), totalLiquidity: poolInfo.totalLiquidity.toString(), loanBalanceMinusAvailable: loanBalanceMinusAvailable.toString() },
    settlement: {
      activeCollateral: activeCollateral.toString(),
      expiredCollateral: expiredCollateral.toString(),
      remainingDefaultCollateral: remainingDefaultCollateral.toString(),
      claimedDefaultCollateral: claimedDefaultCollateral.toString(),
      remainingRepaymentReserve: remainingRepaymentReserve.toString(),
      claimedOrReinvestedRepayments: claimedOrReinvestedRepayments.toString(),
      scanComplete,
    },
    loans: {
      scanned: loans.length,
      outstanding: outstanding.length,
      repaid: repaid.length,
      expiredUnrepaid: expiredUnrepaid.length,
      committedLoanAmount: committedLoanAmount.toString(),
      settledRepayments: settledRepayments.toString(),
      defaultedCollateral: defaultedCollateral.toString(),
      records: loans,
    },
  };
}

function display(report) {
  const { summary } = report;
  console.log(`VinuChain legacy reconciliation: ${summary.status} at block ${report.block.number}`);
  console.log(`RPC chain ${report.rpc.chainId}; pools ${summary.pools}/${report.pools.length}; errors ${summary.errors}; warnings ${summary.warnings}`);
  for (const finding of report.findings) console.log(`${finding.severity.toUpperCase()} ${finding.code} ${finding.scope}`);
  console.log(jsonStringify(report, 2));
}

function jsonStringify(value, spacing = undefined) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), spacing);
}

function printHelp() {
  console.log(`Usage: node scripts/reconcile-legacy.mjs [options]

Options:
  --rpc-url URL       Read-only JSON-RPC endpoint (default: manifest URL)
  --block NUMBER      Historical block (default: latest)
  --max-loans NUMBER  Per-pool loan scan cap (default: 1000)
  --manifest PATH     Manifest path (default: deployments/vinuchain-legacy.json)
  --json              Emit machine-readable JSON only
  --self-check        Validate manifest and Keccak implementation without RPC
  --help              Show this help

Exit codes: 0 healthy, 2 reconciled but degraded by known legacy risks, 1 RPC or accounting mismatch.`);
}

export { NEW_SUB_POOL_INTERFACE, NEW_SUB_POOL_TOPIC, keccak256, loadManifest, readNewSubPoolEvents, resolveReadTag, safeRpcOrigin, validateManifest };

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const manifest = validateManifest(loadManifest(args.manifest));
  if (args.selfCheck) {
    if (keccak256(Buffer.alloc(0)) !== "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") throw new Error("Keccak self-check failed");
    const poolHashes = new Set(manifest.pools.map((pool) => pool.runtimeKeccak.toLowerCase()));
    if (poolHashes.size !== 1) throw new Error("Pool runtime hashes are not uniform in the manifest");
    if (manifest.network.observedBlock !== 14707477) throw new Error("Manifest observation block changed without evidence");
    if (manifest.network.observedBlockTimestamp !== 1788069122) throw new Error("Manifest observation timestamp changed without evidence");
    for (const fork of ["Shanghai", "Cancun", "Prague", "VinuLatestEVM"]) {
      if (manifest.network.forkRulesAtLatest?.[fork] !== true) throw new Error(`Manifest fork rule ${fork} is not pinned true`);
    }
    const usdtPools = manifest.pools.filter((pool) => pool.collateralToken === "usdt");
    if (usdtPools.length !== 6) throw new Error("Manifest must identify six USDT-collateral pools");
    if (usdtPools.filter((pool) => pool.declaredCollateralDecimals !== manifest.tokens[pool.collateralToken].decimals).length !== 2) throw new Error("Manifest must identify two declared/token decimal mismatches");
    if (manifest.pools.some((pool) => pool.sourceVerification !== "NONE")) throw new Error("Legacy pool source verification must not be claimed");
    if (manifest.network.eventScanStartBlock !== 100000) throw new Error("Manifest eventScanStartBlock must remain 100000");
    const observedLoan = manifest.observedLoans?.find((item) => sameAddress(item.pool, "0xB8F54383b78FAb60D2eCedc59B5cde9a6ae655d1") && String(item.loanIdx) === "1");
    if (observedLoan?.borrower !== "0x9ceaab056d465812c9e0edce6f0f24f4d99ee79a") throw new Error("Manifest wvc-vinu-legacy-1 loan 1 borrower changed without evidence");
    if (safeRpcOrigin("https://rpc-user:rpc-password@rpc.vinuchain.org/private/secret?api_key=query-secret#fragment-secret") !== "https://rpc.vinuchain.org") throw new Error("RPC URL redaction self-check failed");
    const result = { status: "PASS", manifest: args.manifest, observedBlock: manifest.network.observedBlock, observedBlockTimestamp: manifest.network.observedBlockTimestamp, pools: manifest.pools.length, usdtPools: usdtPools.length, decimalMismatches: 2, sourceVerification: "NONE_FOR_POOLS", keccak: "PASS" };
    if (args.json) console.log(jsonStringify(result));
    else console.log(`Legacy reconciliation self-check passed (${manifest.pools.length} pools; ${usdtPools.length} USDT pools; 2 declared/token decimal mismatches; Keccak-256 verified).`);
    return 0;
  }

  const rpc = new RpcClient(args.rpcUrl ?? manifest.network.rpcUrl);
  const tag = blockTag(args.block);
  const maxLoans = Number(args.maxLoans ?? 1000);
  if (!Number.isInteger(maxLoans) || maxLoans < 0 || maxLoans > 100_000) throw new Error("--max-loans must be an integer from 0 to 100000");
  const findings = [];
  const chainId = Number(await rpc.request("eth_chainId", []));
  compare(findings, "rpc.chainId", manifest.network.chainId, chainId, "WRONG_CHAIN");
  const blockNumberHex = tag === "latest" ? await rpc.request("eth_blockNumber", []) : tag;
  const block = await rpc.request("eth_getBlockByNumber", [blockNumberHex, false]);
  if (!block) throw new Error(`Block not found: ${blockNumberHex}`);
  const blockNumber = Number(BigInt(block.number));
  const blockTimestamp = BigInt(block.timestamp);
  // Resolve the head once so all reads in this report describe one chain state.
  const callTag = resolveReadTag(args.block, blockNumberHex);
  const runtime = {};
  for (const [key, item] of Object.entries(manifest.contracts)) runtime[key] = await readRuntime(rpc, item, `contracts.${key}`, callTag, findings);
  const tokens = {};
  for (const [key, item] of Object.entries(manifest.tokens)) tokens[key] = await readToken(rpc, item, callTag, findings);
  const controller = manifest.contracts.controller.address;
  const [voteToken, pauseThreshold, unpauseThreshold, whitelistThreshold, dewhitelistThreshold, snapshotTokenEvery, lockPeriod, vetoHolder, numProposals] = await Promise.all([
    readAddress(rpc, controller, "voteToken()", [], callTag),
    readUint(rpc, controller, "pauseThreshold()", [], callTag),
    readUint(rpc, controller, "unpauseThreshold()", [], callTag),
    readUint(rpc, controller, "whitelistThreshold()", [], callTag),
    readUint(rpc, controller, "dewhitelistThreshold()", [], callTag),
    readUint(rpc, controller, "snapshotTokenEvery()", [], callTag),
    readUint(rpc, controller, "lockPeriod()", [], callTag),
    readAddress(rpc, controller, "vetoHolder()", [], callTag),
    readUint(rpc, controller, "numProposals()", [], callTag),
  ]);
  const expectedController = manifest.contracts.controller.constructor;
  compare(findings, "controller.voteToken", expectedController.voteToken, voteToken);
  for (const key of ["pauseThreshold", "unpauseThreshold", "whitelistThreshold", "dewhitelistThreshold", "snapshotTokenEvery", "lockPeriod"]) {
    compare(findings, `controller.constructor.${key}`, expectedController[key], { pauseThreshold, unpauseThreshold, whitelistThreshold, dewhitelistThreshold, snapshotTokenEvery, lockPeriod }[key]);
  }
  compare(findings, "controller.vetoHolder", expectedController.vetoHolder, vetoHolder);
  const controllerState = {
    constructor: { voteToken, pauseThreshold, unpauseThreshold, whitelistThreshold, dewhitelistThreshold, snapshotTokenEvery, lockPeriod, vetoHolder },
    numProposals: numProposals.toString(),
    revenue: {},
  };
  for (const [key, token] of Object.entries(manifest.tokens)) {
    const currentRevenue = await readUint(rpc, controller, "currentRevenue(address)", [{ type: "address", value: token.address }], callTag);
    const balance = await readUint(rpc, token.address, "balanceOf(address)", [{ type: "address", value: controller }], callTag);
    controllerState.revenue[key] = { currentRevenue: currentRevenue.toString(), balance: balance.toString() };
  }
  const pools = [];
  for (const pool of manifest.pools) pools.push(await readPool(rpc, pool, manifest, callTag, blockTimestamp, maxLoans, findings));
  const events = await readNewSubPoolEvents(rpc, manifest, blockNumberHex, findings);
  const knownRiskCodes = new Set(findings.filter((finding) => finding.severity === "warning").map((finding) => finding.code));
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;
  const status = errors > 0 ? "UNHEALTHY" : warnings > 0 || manifest.knownRisks?.length ? "DEGRADED" : "HEALTHY";
  const report = {
    manifest: { path: args.manifest, generation: manifest.network.generation, observedBlock: manifest.network.observedBlock },
    rpc: { url: rpc.url, chainId },
    block: { number: blockNumber, hash: block.hash, timestamp: Number(blockTimestamp) },
    contracts: runtime,
    tokens,
    controller: controllerState,
    pools,
    events,
    findings,
    knownRisks: manifest.knownRisks,
    summary: { status, pools: pools.length, errors, warnings, knownRiskCodes: [...knownRiskCodes] },
  };
  if (args.json) console.log(jsonStringify(report));
  else display(report);
  return errors > 0 ? 1 : warnings > 0 || manifest.knownRisks?.length ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exitCode = code).catch((error) => {
    console.error(`reconcile-legacy: ${error.message}`);
    process.exitCode = 1;
  });
}
