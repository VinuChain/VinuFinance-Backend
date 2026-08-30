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
// The Explorer is used only as a bounded transaction index.  These limits are
// deliberately small for the fixed legacy deployment (11 addresses) and are
// part of the report's completeness contract.
const EXPLORER_PAGE_SIZE_CAP = 100;
const EXPLORER_MAX_PAGES = 16;
const EXPLORER_MAX_TRANSACTIONS = 1_000;
const EXPLORER_TIMEOUT_MS = 10_000;
const EXPLORER_MAX_RESPONSE_BYTES = 2_000_000;
// Pool/controller calls are short, but the fixed address inventory includes
// one contract-creation transaction whose init code is ~26 KB.
const EXPLORER_MAX_RAW_INPUT_BYTES = 64 * 1024;
const EXPLORER_RESULT_VALUES = new Set(["success", "error", "failed", "reverted", "awaiting_internal_transactions", "pending"]);
const NEW_SUB_POOL_INTERFACE = new ethersUtils.Interface([
  "event NewSubPool(address loanCcyToken,address collCcyToken,uint256 loanTenor,uint256 maxLoanPerColl,uint256 r1,uint256 r2,uint256 liquidityBnd1,uint256 liquidityBnd2,uint256 minLoan,uint256 creatorFee,address poolController,uint96 rewardCoefficient)",
]);
const NEW_SUB_POOL_TOPIC = NEW_SUB_POOL_INTERFACE.getEventTopic("NewSubPool");
const LP_INTERFACE = new ethersUtils.Interface([
  "event AddLiquidity(address indexed lp,uint256 amount,uint256 newLpShares,uint256 totalLiquidity,uint256 totalLpShares,uint256 earliestRemove,uint256 indexed loanIdx,uint256 indexed referralCode)",
  "function getLpInfo(address) view returns (uint32 fromLoanIdx,uint32 earliestRemove,uint32 currSharePtr,uint256[] sharesOverTime,uint256[] loanIdxsWhereSharesChanged)",
]);
const ADD_LIQUIDITY_TOPIC = LP_INTERFACE.getEventTopic("AddLiquidity");
const ANALYTICS_POOL_INTERFACE = new ethersUtils.Interface([
  "function borrow(address,uint128,uint128,uint128,uint256,uint256)",
  "function repay(uint256,address)",
  "event Borrow(address indexed borrower,uint256 loanIdx,uint256 collateral,uint256 loanAmount,uint256 repaymentAmount,uint256 totalLpShares,uint256 indexed expiry,uint256 indexed referralCode)",
]);
const ANALYTICS_CONTROLLER_INTERFACE = new ethersUtils.Interface([
  "function depositRewardSupply(uint256)",
  "function collectReward(bool)",
  "function depositRevenue(address,uint256)",
  "event TokenSnapshotPerformed(address indexed tokenId,uint256 tokenSnapshotIdx,uint256 voteTokenTotalSupply,uint256 collectedRevenue,uint256 subTimestamp)",
  "event TokenClaimed(address indexed tokenId,address indexed account,uint256 indexed tokenSnapshotIdx,uint256 accountSnapshotIdx,uint256 amount,uint256 totalClaimedRevenue)",
  "event Reward(address account,uint128 liquidity,uint32 duration,uint96 rewardCoefficient,uint256 amount)",
  "event DepositedVoteToken(address indexed account,uint256 amount,uint256 newBalance,uint256 newTotalSupply,uint256 subTimestamp)",
]);
const ANALYTICS_CONTROLLER_TOPICS = [
  "TokenSnapshotPerformed",
  "TokenClaimed",
  "Reward",
  "DepositedVoteToken",
].map((name) => ANALYTICS_CONTROLLER_INTERFACE.getEventTopic(name));
const BORROW_TOPIC = ANALYTICS_POOL_INTERFACE.getEventTopic("Borrow");
const TRANSFER_SELECTOR = selector("transfer(address,uint256)");
const TRANSFER_FROM_SELECTOR = selector("transferFrom(address,address,uint256)");

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

function safeExplorerApiUrl(url) {
  const parsed = url instanceof URL ? new URL(url.toString()) : new URL(url);
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password) {
    throw new Error("Explorer API URL must be HTTPS (HTTP is allowed only for localhost) without credentials");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validHash(value) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}

function validHex(value) {
  return typeof value === "string" && /^0x[0-9a-f]*$/i.test(value) && value.length % 2 === 0;
}

function validDecimal(value) {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function validateNextPageParams(value, label) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value) || Object.keys(value).length === 0) throw new Error(`${label}.next_page_params must be null or a non-empty object`);
  if (Object.keys(value).length > 12 || Object.entries(value).some(([key, item]) => !/^[A-Za-z0-9_]{1,64}$/.test(key) || (typeof item !== "string" && typeof item !== "number") || (typeof item === "string" && item.length > 256) || (typeof item === "number" && (!Number.isSafeInteger(item) || item < 0)))) {
    throw new Error(`${label}.next_page_params has an invalid schema`);
  }
  return value;
}

function validateExplorerAddressTransaction(item, index) {
  const label = `Explorer transaction ${index}`;
  if (!isPlainObject(item)) throw new Error(`${label} must be an object`);
  if (!validHash(item.hash)) throw new Error(`${label}.hash is invalid`);
  if (!validHex(item.raw_input) || Buffer.byteLength(item.raw_input, "utf8") > EXPLORER_MAX_RAW_INPUT_BYTES) throw new Error(`${label}.raw_input is invalid or oversized`);
  if (!Number.isSafeInteger(item.block_number) || item.block_number < 0) throw new Error(`${label}.block_number is invalid`);
  if (!isPlainObject(item.from) || !ADDRESS_RE.test(item.from.hash)) throw new Error(`${label}.from.hash is invalid`);
  if (item.to !== null && item.to !== undefined && (!isPlainObject(item.to) || !ADDRESS_RE.test(item.to.hash))) throw new Error(`${label}.to.hash is invalid`);
  if (typeof item.result !== "string") throw new Error(`${label}.result is invalid`);
  return item;
}

function validateExplorerAddressTransactionPage(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.items)) throw new Error("Explorer transaction page must contain an items array");
  if (payload.items.length > EXPLORER_PAGE_SIZE_CAP) throw new Error(`Explorer transaction page exceeds ${EXPLORER_PAGE_SIZE_CAP} items`);
  const nextPageParams = validateNextPageParams(payload.next_page_params, "Explorer transaction page");
  const items = payload.items.map(validateExplorerAddressTransaction);
  return { items, nextPageParams };
}

function validateExplorerTransfer(item, index) {
  const label = `Explorer transfer ${index}`;
  if (!isPlainObject(item) || !validHash(item.transaction_hash)) throw new Error(`${label}.transaction_hash is invalid`);
  if (!isPlainObject(item.from) || !ADDRESS_RE.test(item.from.hash)) throw new Error(`${label}.from.hash is invalid`);
  if (!isPlainObject(item.to) || !ADDRESS_RE.test(item.to.hash)) throw new Error(`${label}.to.hash is invalid`);
  if (!isPlainObject(item.token) || !ADDRESS_RE.test(item.token.address)) throw new Error(`${label}.token.address is invalid`);
  if (!isPlainObject(item.total) || !validDecimal(item.total.value) || !validDecimal(item.total.decimals)) throw new Error(`${label}.total is invalid`);
  return item;
}

function validateExplorerTransferPage(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.items)) throw new Error("Explorer transfer page must contain an items array");
  if (payload.items.length > EXPLORER_PAGE_SIZE_CAP) throw new Error(`Explorer transfer page exceeds ${EXPLORER_PAGE_SIZE_CAP} items`);
  const nextPageParams = validateNextPageParams(payload.next_page_params, "Explorer transfer page");
  const items = payload.items.map(validateExplorerTransfer);
  return { items, nextPageParams };
}

class ExplorerClient {
  constructor(url, timeoutMs = EXPLORER_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
    this.baseUrl = safeExplorerApiUrl(url);
    this.timeoutMs = timeoutMs;
    if (typeof fetchImpl !== "function") throw new Error("Explorer API fetch is unavailable");
    this.fetchImpl = fetchImpl;
  }

  async request(path, query = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error("Explorer API path must be absolute");
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), { headers: { accept: "application/json" }, signal: controller.signal });
      if (!response?.ok) throw new Error(`Explorer HTTP ${response?.status ?? "unknown"}`);
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > EXPLORER_MAX_RESPONSE_BYTES) throw new Error(`Explorer response exceeds ${EXPLORER_MAX_RESPONSE_BYTES} bytes`);
      try {
        return JSON.parse(body);
      } catch (_error) {
        throw new Error("Explorer response is not valid JSON");
      }
    } catch (error) {
      if (error?.name === "AbortError") throw new Error(`Explorer API timeout after ${this.timeoutMs}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  addressTransactions(address, pageParams = undefined) {
    if (!ADDRESS_RE.test(address)) throw new Error(`Invalid Explorer address: ${address}`);
    return this.request(`/addresses/${address}/transactions`, pageParams);
  }

  transactionTransfers(hash, pageParams = undefined) {
    if (!validHash(hash)) throw new Error(`Invalid Explorer transaction hash: ${hash}`);
    return this.request(`/transactions/${hash}/token-transfers`, pageParams);
  }
}

async function readExplorerAddressTransactions(client, address, {
  maxPages = EXPLORER_MAX_PAGES,
  maxTransactions = EXPLORER_MAX_TRANSACTIONS,
} = {}) {
  if (!client || typeof client.addressTransactions !== "function") throw new Error("Explorer transaction client is invalid");
  if (!ADDRESS_RE.test(address)) throw new Error(`Invalid Explorer address: ${address}`);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("Explorer page cap must be positive");
  if (!Number.isInteger(maxTransactions) || maxTransactions < 1) throw new Error("Explorer transaction cap must be positive");
  const transactions = [];
  let pageParams;
  let pages = 0;
  while (true) {
    pages += 1;
    if (pages > maxPages) throw new Error(`Explorer page cap exceeded for ${address}`);
    const page = validateExplorerAddressTransactionPage(await client.addressTransactions(address, pageParams));
    if (transactions.length + page.items.length > maxTransactions) throw new Error(`Explorer transaction cap exceeded for ${address}`);
    transactions.push(...page.items);
    if (!page.nextPageParams) return { address: address.toLowerCase(), pages, transactions };
    pageParams = page.nextPageParams;
  }
}

async function readExplorerTransactionTransfers(client, hash, {
  maxPages = EXPLORER_MAX_PAGES,
  maxTransactions = EXPLORER_MAX_TRANSACTIONS,
} = {}) {
  if (!client || typeof client.transactionTransfers !== "function") throw new Error("Explorer transfer client is invalid");
  if (!validHash(hash)) throw new Error(`Invalid Explorer transaction hash: ${hash}`);
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error("Explorer transfer page cap must be positive");
  if (!Number.isInteger(maxTransactions) || maxTransactions < 1) throw new Error("Explorer transfer cap must be positive");
  const transfers = [];
  let pageParams;
  let pages = 0;
  while (true) {
    pages += 1;
    if (pages > maxPages) throw new Error(`Explorer transfer page cap exceeded for ${hash}`);
    const page = validateExplorerTransferPage(await client.transactionTransfers(hash, pageParams));
    if (transfers.length + page.items.length > maxTransactions) throw new Error(`Explorer transfer cap exceeded for ${hash}`);
    transfers.push(...page.items);
    if (!page.nextPageParams) return { hash: hash.toLowerCase(), pages, transfers };
    pageParams = page.nextPageParams;
  }
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

async function readControllerAnalyticsEvents(rpc, manifest, toBlockHex, findings) {
  const fromBlock = BigInt(manifest.network.eventScanStartBlock);
  const toBlock = BigInt(toBlockHex);
  if (fromBlock > toBlock) throw new Error(`Controller event range starts after block ${toBlock}`);
  const logs = [];
  let chunks = 0;
  for (let start = fromBlock; start <= toBlock; start += BigInt(EVENT_CHUNK_SIZE)) {
    chunks += 1;
    if (chunks > MAX_EVENT_CHUNKS) throw new Error(`Controller event scan cap exceeded at ${chunks} chunks`);
    const end = start + BigInt(EVENT_CHUNK_SIZE - 1) < toBlock ? start + BigInt(EVENT_CHUNK_SIZE - 1) : toBlock;
    const result = await rpc.request("eth_getLogs", [{
      address: manifest.contracts.controller.address,
      fromBlock: blockTag(start.toString()),
      toBlock: blockTag(end.toString()),
      topics: [ANALYTICS_CONTROLLER_TOPICS],
    }]);
    if (!Array.isArray(result)) throw new Error("eth_getLogs returned a non-array Controller analytics response");
    logs.push(...result);
  }
  const snapshots = [];
  const claims = [];
  const rewards = [];
  const depositedVoteTokens = [];
  for (const log of logs) {
    let parsed;
    try {
      parsed = ANALYTICS_CONTROLLER_INTERFACE.parseLog({ topics: log.topics, data: log.data });
    } catch (error) {
      addFinding(findings, "error", "CONTROLLER_ANALYTICS_EVENT_DECODE_FAILED", "controller.analyticsEvents.log", "known Controller analytics ABI", error.message);
      continue;
    }
    const base = {
      block: Number(BigInt(log.blockNumber)),
      transactionHash: String(log.transactionHash).toLowerCase(),
    };
    if (parsed.name === "TokenSnapshotPerformed") {
      snapshots.push({
        ...base,
        token: String(parsed.args.tokenId).toLowerCase(),
        snapshotIndex: textValue(parsed.args.tokenSnapshotIdx),
        collectedRevenue: textValue(parsed.args.collectedRevenue),
      });
    } else if (parsed.name === "TokenClaimed") {
      claims.push({
        ...base,
        token: String(parsed.args.tokenId).toLowerCase(),
        account: String(parsed.args.account).toLowerCase(),
        amount: textValue(parsed.args.amount),
        totalClaimedRevenue: textValue(parsed.args.totalClaimedRevenue),
      });
    } else if (parsed.name === "Reward") {
      rewards.push({
        ...base,
        account: String(parsed.args.account).toLowerCase(),
        amount: textValue(parsed.args.amount),
      });
    } else if (parsed.name === "DepositedVoteToken") {
      depositedVoteTokens.push({
        ...base,
        account: String(parsed.args.account).toLowerCase(),
        amount: textValue(parsed.args.amount),
        newBalance: textValue(parsed.args.newBalance),
        newTotalSupply: textValue(parsed.args.newTotalSupply),
      });
    }
  }
  return {
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    chunkSize: EVENT_CHUNK_SIZE,
    chunks,
    topics: ANALYTICS_CONTROLLER_TOPICS,
    snapshots,
    claims,
    rewards,
    depositedVoteTokens,
  };
}

function parseAnalyticsTransaction(iface, item) {
  try {
    return iface.parseTransaction({ data: item.raw_input });
  } catch (_error) {
    return undefined;
  }
}

function bigintArg(args, index) {
  const value = args[index];
  if (value === undefined || value === null) throw new Error(`Missing ABI argument ${index}`);
  return BigInt(value.toString());
}

function decodeTraceTransferCall(trace) {
  if (!isPlainObject(trace) || trace.type !== "call" || !isPlainObject(trace.action)) return undefined;
  if (trace.error || trace.action.error || !ADDRESS_RE.test(trace.action.to ?? "") || !validHex(trace.action.input)) return undefined;
  const input = trace.action.input.toLowerCase();
  const args = `0x${input.slice(10)}`;
  try {
    if (input.startsWith(`0x${TRANSFER_SELECTOR}`)) {
      return {
        from: String(trace.action.from).toLowerCase(),
        to: decodeAddress(args, 0).toLowerCase(),
        token: String(trace.action.to).toLowerCase(),
        amount: decodeWord(args, 1),
      };
    }
    if (input.startsWith(`0x${TRANSFER_FROM_SELECTOR}`)) {
      return {
        from: decodeAddress(args, 0).toLowerCase(),
        to: decodeAddress(args, 1).toLowerCase(),
        token: String(trace.action.to).toLowerCase(),
        amount: decodeWord(args, 2),
      };
    }
  } catch (_error) {
    return undefined;
  }
  return undefined;
}

function decodeTraceTransfers(traceResult) {
  if (!Array.isArray(traceResult)) throw new Error("trace_transaction returned a non-array result");
  return traceResult.map(decodeTraceTransferCall).filter(Boolean);
}

async function readTransactionTransfers(explorer, rpc, hash) {
  try {
    const report = await readExplorerTransactionTransfers(explorer, hash);
    return { source: "vinuexplorer-token-transfers", pages: report.pages, transfers: report.transfers.map((item) => ({
      from: item.from.hash.toLowerCase(),
      to: item.to.hash.toLowerCase(),
      token: item.token.address.toLowerCase(),
      amount: BigInt(item.total.value),
    })) };
  } catch (explorerError) {
    if (!rpc || typeof rpc.request !== "function") throw new Error(`Token transfer retrieval failed: ${explorerError.message}`);
    try {
      const traceResult = await rpc.request("trace_transaction", [hash]);
      return { source: "rpc-trace_transaction", pages: 1, transfers: decodeTraceTransfers(traceResult) };
    } catch (traceError) {
      throw new Error(`Token transfer retrieval failed (Explorer: ${explorerError.message}; RPC trace: ${traceError.message})`);
    }
  }
}

function decodeLpOwners(logs, manifest, findings) {
  const expectedPools = new Map(manifest.pools.map((pool) => [pool.address.toLowerCase(), pool]));
  const owners = new Map(manifest.pools.map((pool) => [pool.address.toLowerCase(), new Set()]));
  let records = 0;
  for (const log of logs) {
    const poolAddress = String(log.address).toLowerCase();
    const pool = expectedPools.get(poolAddress);
    if (!pool) {
      addFinding(findings, "error", "UNEXPECTED_LP_EVENT_POOL", `lpEvents.${poolAddress}`, "manifest pool", poolAddress);
      continue;
    }
    try {
      const parsed = LP_INTERFACE.parseLog({ topics: log.topics, data: log.data });
      const owner = String(parsed.args.lp).toLowerCase();
      if (!ADDRESS_RE.test(owner)) throw new Error("invalid LP address");
      owners.get(poolAddress).add(owner);
      records += 1;
    } catch (error) {
      addFinding(findings, "error", "LP_EVENT_DECODE_FAILED", `lpEvents.${pool.id}`, "AddLiquidity ABI", error.message);
    }
  }
  return { owners, records };
}

async function readLpOwnerEvents(rpc, manifest, toBlockHex, findings) {
  const fromBlock = BigInt(manifest.network.eventScanStartBlock);
  const toBlock = BigInt(toBlockHex);
  if (fromBlock > toBlock) {
    addFinding(findings, "error", "LP_EVENT_SCAN_RANGE_INVALID", "lpEvents.range", `<= ${toBlock}`, fromBlock);
    return { fromBlock: Number(fromBlock), toBlock: Number(toBlock), chunkSize: EVENT_CHUNK_SIZE, chunks: 0, records: 0, owners: new Map() };
  }

  const logs = [];
  let chunks = 0;
  for (let start = fromBlock; start <= toBlock; start += BigInt(EVENT_CHUNK_SIZE)) {
    chunks += 1;
    if (chunks > MAX_EVENT_CHUNKS) {
      addFinding(findings, "error", "LP_EVENT_SCAN_CAP_EXCEEDED", "lpEvents.chunks", `<= ${MAX_EVENT_CHUNKS}`, chunks);
      break;
    }
    const end = start + BigInt(EVENT_CHUNK_SIZE - 1) < toBlock ? start + BigInt(EVENT_CHUNK_SIZE - 1) : toBlock;
    const result = await rpc.request("eth_getLogs", [{
      address: manifest.pools.map((pool) => pool.address),
      fromBlock: blockTag(start.toString()),
      toBlock: blockTag(end.toString()),
      topics: [ADD_LIQUIDITY_TOPIC],
    }]);
    if (!Array.isArray(result)) throw new Error("eth_getLogs returned a non-array LP event response");
    logs.push(...result);
  }
  return {
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    chunkSize: EVENT_CHUNK_SIZE,
    chunks,
    topic: ADD_LIQUIDITY_TOPIC,
    ...decodeLpOwners(logs, manifest, findings),
  };
}

function lpEntitlement(totalLiquidity, minLiquidity, totalLpShares, currentShares) {
  if (currentShares < 0n || totalLpShares < 0n || currentShares > totalLpShares) throw new Error("LP shares are outside the pool total");
  if (totalLpShares === 0n) {
    if (currentShares !== 0n) throw new Error("nonzero LP shares with zero pool share supply");
    return 0n;
  }
  if (totalLiquidity < minLiquidity) throw new Error("pool liquidity is below its reserved minimum");
  return ((totalLiquidity - minLiquidity) * currentShares) / totalLpShares;
}

async function readLpPositions(rpc, manifest, poolReports, tag, blockTimestamp, toBlockHex, findings) {
  const eventReport = await readLpOwnerEvents(rpc, manifest, toBlockHex, findings);
  const reportsByAddress = new Map(poolReports.map((pool) => [pool.address.toLowerCase(), pool]));
  const byPool = [];
  const historicalOwnerSet = new Set();
  let currentPositions = 0;

  for (const pool of manifest.pools) {
    const address = pool.address.toLowerCase();
    const poolReport = reportsByAddress.get(address);
    const historicalOwners = [...(eventReport.owners.get(address) ?? [])].sort();
    historicalOwners.forEach((owner) => historicalOwnerSet.add(owner));
    const positions = [];
    let observedShares = 0n;
    let observedEntitlement = 0n;

    for (const owner of historicalOwners) {
      const data = await readCall(rpc, pool.address, "getLpInfo(address)", [{ type: "address", value: owner }], tag);
      const decoded = LP_INTERFACE.decodeFunctionResult("getLpInfo", data);
      const sharesOverTime = decoded.sharesOverTime.map((value) => BigInt(value.toString()));
      const currentShares = sharesOverTime.length ? sharesOverTime[sharesOverTime.length - 1] : 0n;
      if (currentShares === 0n) continue;

      const fromLoanIdx = BigInt(decoded.fromLoanIdx.toString());
      const earliestRemove = BigInt(decoded.earliestRemove.toString());
      const lastTrackedLiquidity = await readUint(rpc, pool.address, "lastTrackedLiquidity(address)", [{ type: "address", value: owner }], tag);
      let entitlement = 0n;
      try {
        entitlement = lpEntitlement(
          BigInt(poolReport.config.totalLiquidity),
          BigInt(poolReport.config.minLiquidity),
          BigInt(poolReport.config.totalLpShares),
          currentShares,
        );
      } catch (error) {
        addFinding(findings, "error", "LP_ENTITLEMENT_INVALID", `${pool.id}.${owner}`, "valid pro-rata position", error.message);
      }

      let fullExit = { status: "TIMELOCKED", error: undefined };
      if (blockTimestamp >= earliestRemove) {
        try {
          await rpc.request("eth_call", [{
            from: owner,
            to: pool.address,
            data: callData("removeLiquidity(address,uint128)", [
              { type: "address", value: owner },
              { type: "uint128", value: currentShares },
            ]),
          }, tag]);
          fullExit = { status: "SUCCESS", error: undefined };
        } catch (error) {
          fullExit = { status: "REVERTED", error: error.message };
          addFinding(findings, "error", "FULL_EXIT_SIMULATION_FAILED", `${pool.id}.${owner}`, "successful owner full exit", error.message);
        }
      }

      observedShares += currentShares;
      observedEntitlement += entitlement;
      currentPositions += 1;
      positions.push({
        owner,
        currentShares: currentShares.toString(),
        lastTrackedLiquidity: lastTrackedLiquidity.toString(),
        entitlement: entitlement.toString(),
        fromLoanIdx: fromLoanIdx.toString(),
        nextLoanIdx: String(poolReport.config.nextLoanIdx),
        claimPrefixEmpty: fromLoanIdx === BigInt(poolReport.config.nextLoanIdx),
        earliestRemove: earliestRemove.toString(),
        fullExit,
      });
    }

    const totalLpShares = BigInt(poolReport.config.totalLpShares);
    compare(findings, `${pool.id}.lpPositions.currentShares`, totalLpShares, observedShares, "LP_SHARE_RECONCILIATION_MISMATCH");
    const availableLiquidity = totalLpShares === 0n
      ? 0n
      : BigInt(poolReport.config.totalLiquidity) - BigInt(poolReport.config.minLiquidity);
    const roundingResidual = availableLiquidity - observedEntitlement;
    if (roundingResidual < 0n || roundingResidual > BigInt(positions.length)) {
      addFinding(findings, "error", "LP_ENTITLEMENT_RECONCILIATION_MISMATCH", `${pool.id}.lpPositions.entitlement`, `rounding residual 0..${positions.length}`, roundingResidual);
    }
    byPool.push({
      id: pool.id,
      address: pool.address,
      historicalOwners: historicalOwners.length,
      currentPositions: positions.length,
      observedShares: observedShares.toString(),
      totalLpShares: totalLpShares.toString(),
      observedEntitlement: observedEntitlement.toString(),
      availableLiquidity: availableLiquidity.toString(),
      roundingResidual: roundingResidual.toString(),
      positions,
    });
  }

  return {
    events: {
      fromBlock: eventReport.fromBlock,
      toBlock: eventReport.toBlock,
      chunkSize: eventReport.chunkSize,
      chunks: eventReport.chunks,
      topic: eventReport.topic,
      records: eventReport.records,
    },
    historicalOwners: historicalOwnerSet.size,
    currentPositions,
    pools: byPool,
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

function addBigInt(map, key, amount) {
  map.set(key, (map.get(key) ?? 0n) + amount);
}

function stringMap(map) {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, value.toString()]));
}

function tokenKey(manifest, address) {
  const token = Object.entries(manifest.tokens).find(([, item]) => sameAddress(item.address, address));
  return token ? token[0] : String(address).toLowerCase();
}

function analyticsSource(manifest, block, retrievedAt) {
  const retrievalBlock = typeof block.number === "number" ? block.number : Number(BigInt(block.number));
  return {
    api: "VinuExplorer v2 address transaction index",
    apiBaseUrl: safeExplorerApiUrl(manifest.network.explorerApiUrl),
    endpoints: [
      "/addresses/{address}/transactions",
      "/transactions/{hash}/token-transfers",
    ],
    retrievedAt,
    retrievalBlock,
    retrievalBlockHash: block.hash,
    fixedAddresses: [manifest.contracts.controller.address, ...manifest.pools.map((pool) => pool.address)],
    assumptions: [
      "Address pages were schema-validated and exhausted through the resolved retrieval block.",
      "Only successful transactions are used for calldata analytics; failed transactions remain explicitly counted and excluded.",
      "Integer token amounts retain the token contract decimals from the RPC manifest; no cross-token TVL conversion is implied.",
      "RPC state, receipts, bounded logs, and eth_call values remain authoritative for on-chain balances and current loan state.",
    ],
    bounds: {
      maxPagesPerAddress: EXPLORER_MAX_PAGES,
      maxTransactionsPerAddress: EXPLORER_MAX_TRANSACTIONS,
      maxPageSize: EXPLORER_PAGE_SIZE_CAP,
      eventChunkSize: EVENT_CHUNK_SIZE,
    },
  };
}

function unavailableAnalytics(manifest, block, retrievedAt, reason) {
  return {
    status: "UNAVAILABLE",
    availability: "UNAVAILABLE",
    source: analyticsSource(manifest, block, retrievedAt),
    reason,
    metrics: "No unavailable metric is represented as zero.",
  };
}

function transferTotal(transfers, predicate) {
  return transfers.reduce((sum, transfer) => (predicate(transfer) ? sum + transfer.amount : sum), 0n);
}

function successfulExplorerTransactions(inventory) {
  return inventory.transactions.filter((item) => item.result.toLowerCase() === "success");
}

function receiptLogsFor(receipt, address, topic) {
  return (receipt.logs ?? []).filter((log) => sameAddress(log.address, address) && String(log.topics?.[0]).toLowerCase() === topic.toLowerCase());
}

async function readReceipt(rpc, hash) {
  const receipt = await rpc.request("eth_getTransactionReceipt", [hash]);
  if (!isPlainObject(receipt) || !Array.isArray(receipt.logs)) throw new Error(`Receipt unavailable for ${hash}`);
  if (receipt.status !== undefined && receipt.status !== "0x1") throw new Error(`Transaction ${hash} did not succeed (status ${receipt.status})`);
  return receipt;
}

function parseBorrowLog(receipt, poolAddress, hash) {
  const logs = receiptLogsFor(receipt, poolAddress, BORROW_TOPIC);
  if (logs.length !== 1) throw new Error(`Expected one Borrow event for ${hash}, found ${logs.length}`);
  const parsed = ANALYTICS_POOL_INTERFACE.parseLog({ topics: logs[0].topics, data: logs[0].data });
  return {
    borrower: String(parsed.args.borrower).toLowerCase(),
    loanIdx: textValue(parsed.args.loanIdx),
    collateral: bigintArg(parsed.args, 2),
    loanAmount: bigintArg(parsed.args, 3),
    repaymentAmount: bigintArg(parsed.args, 4),
  };
}

function parseControllerEventFromReceipt(receipt, address, name) {
  const topic = ANALYTICS_CONTROLLER_INTERFACE.getEventTopic(name);
  const logs = receiptLogsFor(receipt, address, topic);
  if (logs.length !== 1) throw new Error(`Expected one ${name} event, found ${logs.length}`);
  return ANALYTICS_CONTROLLER_INTERFACE.parseLog({ topics: logs[0].topics, data: logs[0].data });
}

function mapPoolTransactionCounts(manifest, inventories) {
  const counts = new Map(manifest.pools.map((pool) => [pool.address.toLowerCase(), { borrow: 0, repay: 0, other: 0 }]));
  for (const [address, inventory] of inventories.entries()) {
    const count = counts.get(address);
    if (!count) continue;
    for (const item of successfulExplorerTransactions(inventory)) {
      const parsed = parseAnalyticsTransaction(ANALYTICS_POOL_INTERFACE, item);
      if (!parsed) {
        count.other += 1;
      } else if (parsed.name === "borrow") {
        count.borrow += 1;
      } else if (parsed.name === "repay") {
        count.repay += 1;
      } else {
        count.other += 1;
      }
    }
  }
  return counts;
}

async function readRewardSupply(rpc, controller, callTag, controllerTransactions, controllerEvents, rewardSupplyDeposits) {
  try {
    return { value: (await readUint(rpc, controller, "rewardSupply()", [], callTag)).toString(), source: `eth_call:${callTag}` };
  } catch (primaryError) {
    // Some RPC nodes cannot serve a historical trie node for this one getter,
    // even while the rest of the snapshot reads succeed. Derive zero only
    // from the immutable constructor default plus an exhausted transaction
    // index proving that no supply deposit or non-zero Reward event exists.
    const hasSupplyDeposit = rewardSupplyDeposits.length > 0 || controllerTransactions.some((item) => parseAnalyticsTransaction(ANALYTICS_CONTROLLER_INTERFACE, item)?.name === "depositRewardSupply");
    const hasRewardDistribution = controllerEvents.rewards.some((event) => BigInt(event.amount) !== 0n);
    if (!hasSupplyDeposit && !hasRewardDistribution) {
      return {
        value: "0",
        source: "derived:Controller constructor default plus exhaustive successful transaction/event inventory",
        unavailablePrimaryRead: primaryError.message,
      };
    }
    throw new Error(`Controller rewardSupply() unavailable: ${primaryError.message}`);
  }
}

function buildLiquidityAnalytics(manifest, poolReports) {
  const groups = new Map();
  for (const pool of poolReports) {
    if (!pool.settlement.scanComplete) throw new Error(`Liquidity committed amount is incomplete for ${pool.id}`);
    const loanToken = String(pool.config.loanToken).toLowerCase();
    const token = Object.values(manifest.tokens).find((item) => sameAddress(item.address, loanToken));
    if (!token) throw new Error(`Liquidity token is not in manifest for ${pool.id}`);
    const key = `${loanToken}:${token.decimals}`;
    const totalLiquidity = BigInt(pool.config.totalLiquidity);
    const reservedLiquidity = BigInt(pool.config.minLiquidity);
    // Empty legacy pools are intentionally at zero while the configured
    // minimum remains one token unit. They contribute zero available
    // liquidity; a non-zero pool below its reserve is an invariant failure.
    if (totalLiquidity !== 0n && totalLiquidity < reservedLiquidity) throw new Error(`Pool liquidity is below reserve for ${pool.id}`);
    const group = groups.get(key) ?? {
      token: token.symbol,
      tokenAddress: loanToken,
      decimals: token.decimals,
      pools: 0,
      totalLiquidity: 0n,
      availableLiquidity: 0n,
      committedLiquidity: 0n,
    };
    group.pools += 1;
    group.totalLiquidity += totalLiquidity;
    group.availableLiquidity += totalLiquidity === 0n ? 0n : totalLiquidity - reservedLiquidity;
    group.committedLiquidity += BigInt(pool.loans.committedLoanAmount);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    totalLiquidity: group.totalLiquidity.toString(),
    availableLiquidity: group.availableLiquidity.toString(),
    committedLiquidity: group.committedLiquidity.toString(),
    utilizationBps: group.availableLiquidity + group.committedLiquidity === 0n
      ? null
      : ((group.committedLiquidity * 10_000n) / (group.availableLiquidity + group.committedLiquidity)).toString(),
  }));
}

async function readAnalytics(rpc, explorer, manifest, block, callTag, poolReports, controllerState, controllerEvents, lpPositions, findings) {
  const retrievedAt = new Date().toISOString();
  const source = analyticsSource(manifest, block, retrievedAt);
  const addresses = [manifest.contracts.controller.address, ...manifest.pools.map((pool) => pool.address)];
  const inventories = new Map();
  for (const address of addresses) {
    const inventory = await readExplorerAddressTransactions(explorer, address);
    inventories.set(address.toLowerCase(), inventory);
  }

  const retrievalBlock = typeof block.number === "number" ? block.number : Number(BigInt(block.number));
  const futureTransactions = [...inventories.values()].flatMap((inventory) => inventory.transactions.filter((item) => item.block_number > retrievalBlock));
  if (futureTransactions.length) throw new Error(`Explorer returned ${futureTransactions.length} transaction(s) after retrieval block ${retrievalBlock}`);
  for (const inventory of inventories.values()) {
    for (const item of inventory.transactions) {
      if (!EXPLORER_RESULT_VALUES.has(item.result.toLowerCase())) throw new Error(`Explorer transaction ${item.hash} has an unsupported result status`);
    }
  }
  const controllerInventory = inventories.get(manifest.contracts.controller.address.toLowerCase());
  const controllerTransactions = successfulExplorerTransactions(controllerInventory);
  const poolTransactionCounts = mapPoolTransactionCounts(manifest, inventories);
  const feeByToken = new Map();
  const controllerFeeTransfersByToken = new Map();
  const borrowRecords = [];
  const controllerActions = [];

  for (const pool of manifest.pools) {
    const inventory = inventories.get(pool.address.toLowerCase());
    for (const item of successfulExplorerTransactions(inventory)) {
      const parsed = parseAnalyticsTransaction(ANALYTICS_POOL_INTERFACE, item);
      if (!parsed || parsed.name !== "borrow") continue;
      const sendAmount = bigintArg(parsed.args, 1);
      const receipt = await readReceipt(rpc, item.hash);
      const borrow = parseBorrowLog(receipt, pool.address, item.hash);
      const transfers = await readTransactionTransfers(explorer, rpc, item.hash);
      // borrow's _sendAmount is the collateral token sent by the borrower;
      // the loan token is the asset sent back by the pool.
      const feeToken = manifest.tokens[pool.collateralToken].address.toLowerCase();
      const controllerAddress = manifest.contracts.controller.address.toLowerCase();
      const incoming = transferTotal(transfers.transfers, (transfer) => sameAddress(transfer.token, feeToken) && sameAddress(transfer.from, borrow.borrower) && sameAddress(transfer.to, pool.address));
      const fee = sendAmount - borrow.collateral;
      if (fee < 0n) throw new Error(`Borrow input is below collateral pledge for ${item.hash}`);
      const controllerTransfer = transferTotal(transfers.transfers, (transfer) => sameAddress(transfer.token, feeToken) && sameAddress(transfer.from, pool.address) && sameAddress(transfer.to, controllerAddress));
      if (incoming !== sendAmount) {
        addFinding(findings, "error", "ANALYTICS_BORROW_INPUT_MISMATCH", `${pool.id}.${item.hash}.input`, sendAmount, incoming);
        throw new Error(`Borrow collateral input transfer mismatch for ${item.hash}`);
      }
      if (controllerTransfer !== fee) {
        addFinding(findings, "error", "ANALYTICS_BORROW_FEE_TRANSFER_MISMATCH", `${pool.id}.${item.hash}.fee`, fee, controllerTransfer);
        throw new Error(`Borrow fee transfer mismatch for ${item.hash}`);
      }
      addBigInt(feeByToken, feeToken, fee);
      addBigInt(controllerFeeTransfersByToken, feeToken, controllerTransfer);
      borrowRecords.push({
        pool: pool.id,
        transactionHash: item.hash.toLowerCase(),
        block: item.block_number,
        borrower: borrow.borrower,
        loanIdx: borrow.loanIdx,
        inputCollateral: sendAmount.toString(),
        collateralPledge: borrow.collateral.toString(),
        fee: fee.toString(),
        controllerTransfer: controllerTransfer.toString(),
        transferSource: transfers.source,
      });
    }
  }

  const rewardSupplyDeposits = [];
  const rewardCollections = [];
  const directRevenueByToken = new Map();
  for (const item of controllerTransactions) {
    const parsed = parseAnalyticsTransaction(ANALYTICS_CONTROLLER_INTERFACE, item);
    if (!parsed) continue;
    if (!["depositRewardSupply", "collectReward", "depositRevenue"].includes(parsed.name)) continue;
    const receipt = await readReceipt(rpc, item.hash);
    const transfers = await readTransactionTransfers(explorer, rpc, item.hash);
    controllerActions.push({ transactionHash: item.hash.toLowerCase(), block: item.block_number, method: parsed.name });
    if (parsed.name === "depositRewardSupply") {
      const amount = bigintArg(parsed.args, 0);
      const incoming = transferTotal(transfers.transfers, (transfer) => sameAddress(transfer.token, controllerState.voteToken) && sameAddress(transfer.from, item.from.hash) && sameAddress(transfer.to, manifest.contracts.controller.address));
      if (incoming !== amount) throw new Error(`Reward supply deposit transfer mismatch for ${item.hash}`);
      rewardSupplyDeposits.push({ transactionHash: item.hash.toLowerCase(), amount: amount.toString() });
    } else if (parsed.name === "collectReward") {
      const deposit = Boolean(parsed.args[0]);
      const outgoing = transferTotal(transfers.transfers, (transfer) => sameAddress(transfer.token, controllerState.voteToken) && sameAddress(transfer.from, manifest.contracts.controller.address) && sameAddress(transfer.to, item.from.hash));
      if (deposit) {
        let eventAmount;
        try {
          const event = parseControllerEventFromReceipt(receipt, manifest.contracts.controller.address, "DepositedVoteToken");
          eventAmount = bigintArg(event.args, 1);
        } catch (_error) {
          eventAmount = undefined;
        }
        if (eventAmount === undefined || outgoing !== 0n) throw new Error(`Reward collection deposit could not be proven for ${item.hash}`);
        rewardCollections.push({ transactionHash: item.hash.toLowerCase(), mode: "deposit", amount: eventAmount.toString() });
      } else {
        if (outgoing === 0n) throw new Error(`Reward collection transfer could not be proven for ${item.hash}`);
        rewardCollections.push({ transactionHash: item.hash.toLowerCase(), mode: "withdraw", amount: outgoing.toString() });
      }
    } else {
      const token = String(parsed.args[0]).toLowerCase();
      const amount = bigintArg(parsed.args, 1);
      const incoming = transferTotal(transfers.transfers, (transfer) => sameAddress(transfer.token, token) && sameAddress(transfer.from, item.from.hash) && sameAddress(transfer.to, manifest.contracts.controller.address));
      if (incoming !== amount) throw new Error(`Controller revenue transfer mismatch for ${item.hash}`);
      addBigInt(directRevenueByToken, token, amount);
    }
  }

  const rewardSupplyRead = await readRewardSupply(rpc, manifest.contracts.controller.address, callTag, controllerTransactions, controllerEvents, rewardSupplyDeposits);
  const rewardSupply = rewardSupplyRead.value;
  const snapshotCollectedByToken = new Map();
  for (const snapshot of controllerEvents.snapshots) addBigInt(snapshotCollectedByToken, snapshot.token, BigInt(snapshot.collectedRevenue));
  const claimedByToken = new Map();
  for (const claim of controllerEvents.claims) addBigInt(claimedByToken, claim.token, BigInt(claim.amount));
  const rewardEventTotal = controllerEvents.rewards.reduce((sum, event) => sum + BigInt(event.amount), 0n);
  const rewards = {
    status: "AVAILABLE",
    rewardSupply,
    rewardSupplySource: rewardSupplyRead.source,
    ...(rewardSupplyRead.unavailablePrimaryRead ? { rewardSupplyReadNote: rewardSupplyRead.unavailablePrimaryRead } : {}),
    supplyDeposits: { transactions: rewardSupplyDeposits.length, total: rewardSupplyDeposits.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString(), records: rewardSupplyDeposits },
    collections: { transactions: rewardCollections.length, total: rewardCollections.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString(), records: rewardCollections },
    rewardEvents: { transactions: controllerEvents.rewards.length, total: rewardEventTotal.toString() },
    proof: rewardSupply === "0" && rewardSupplyDeposits.length === 0 && rewardCollections.length === 0 && rewardEventTotal === 0n
      ? "Current reward supply, reward deposits, collections, and Reward event amounts are all exactly zero at the resolved block."
      : undefined,
  };

  const feeTokens = new Set([...Object.values(manifest.tokens).map((token) => token.address.toLowerCase()), ...feeByToken.keys(), ...directRevenueByToken.keys(), ...snapshotCollectedByToken.keys()]);
  const fees = {};
  for (const address of feeTokens) {
    const key = tokenKey(manifest, address);
    const borrowFees = feeByToken.get(address) ?? 0n;
    const controllerTransfers = controllerFeeTransfersByToken.get(address) ?? 0n;
    const directRevenue = directRevenueByToken.get(address) ?? 0n;
    const snapshots = snapshotCollectedByToken.get(address) ?? 0n;
    const currentRevenue = BigInt(controllerState.revenue[key]?.currentRevenue ?? "0");
    const knownRevenue = borrowFees + directRevenue;
    const grossRevenue = snapshots + currentRevenue;
    if (controllerTransfers !== borrowFees) {
      addFinding(findings, "error", "ANALYTICS_CONTROLLER_FEE_RECONCILIATION_MISMATCH", `fees.${key}.controllerTransfer`, borrowFees, controllerTransfers);
      throw new Error(`Controller fee transfer mismatch for ${key}`);
    }
    if (knownRevenue > grossRevenue) {
      addFinding(findings, "error", "ANALYTICS_REVENUE_NEGATIVE_RESIDUAL", `fees.${key}.grossRevenue`, grossRevenue, knownRevenue);
      throw new Error(`Controller revenue residual is negative for ${key}`);
    }
    fees[key] = {
      token: key,
      tokenAddress: address,
      borrowFees: borrowFees.toString(),
      controllerFeeTransfers: controllerTransfers.toString(),
      directRevenue: directRevenue.toString(),
      snapshotCollectedRevenue: snapshots.toString(),
      currentRevenue: currentRevenue.toString(),
      grossRevenue: grossRevenue.toString(),
      knownRevenue: knownRevenue.toString(),
      unattributedRevenue: (grossRevenue - knownRevenue).toString(),
      status: "AVAILABLE",
    };
  }

  const portfolioByToken = new Map();
  for (const poolPosition of lpPositions.pools) {
    const pool = manifest.pools.find((item) => item.id === poolPosition.id);
    if (!pool) throw new Error(`LP position references unknown pool ${poolPosition.id}`);
    const token = manifest.tokens[pool.loanToken];
    const key = pool.loanToken;
    const existing = portfolioByToken.get(key) ?? { token: token.symbol, tokenAddress: token.address, decimals: token.decimals, currentPositions: 0, currentShares: 0n, redeemableLiquidity: 0n };
    existing.currentPositions += poolPosition.currentPositions;
    existing.currentShares += BigInt(poolPosition.observedShares);
    existing.redeemableLiquidity += BigInt(poolPosition.observedEntitlement);
    portfolioByToken.set(key, existing);
  }
  const portfolio = [...portfolioByToken.entries()].map(([key, value]) => ({ ...value, token: key, currentShares: value.currentShares.toString(), redeemableLiquidity: value.redeemableLiquidity.toString() }));
  const portfolioByOwner = new Map();
  for (const poolPosition of lpPositions.pools) {
    const pool = manifest.pools.find((item) => item.id === poolPosition.id);
    const token = manifest.tokens[pool.loanToken];
    for (const position of poolPosition.positions) {
      const owner = position.owner.toLowerCase();
      const existing = portfolioByOwner.get(owner) ?? { owner, currentPositions: 0, positions: [], redeemableByToken: new Map() };
      existing.currentPositions += 1;
      existing.positions.push({
        pool: pool.id,
        token: pool.loanToken,
        tokenAddress: token.address,
        currentShares: position.currentShares,
        redeemableLiquidity: position.entitlement,
        fullExit: position.fullExit,
      });
      addBigInt(existing.redeemableByToken, pool.loanToken, BigInt(position.entitlement));
      portfolioByOwner.set(owner, existing);
    }
  }
  const users = [...portfolioByOwner.values()].map((user) => ({
    owner: user.owner,
    currentPositions: user.currentPositions,
    redeemableByToken: stringMap(user.redeemableByToken),
    positions: user.positions,
  }));
  return {
    status: "AVAILABLE",
    availability: "AVAILABLE",
    source,
    inventory: {
      addresses: [...inventories.entries()].map(([address, inventory]) => ({
        address,
        pages: inventory.pages,
        transactions: inventory.transactions.length,
        successful: successfulExplorerTransactions(inventory).length,
        excludedFailed: inventory.transactions.length - successfulExplorerTransactions(inventory).length,
      })),
      totalTransactions: [...inventories.values()].reduce((sum, inventory) => sum + inventory.transactions.length, 0),
    },
    liquidity: { status: "AVAILABLE", byLoanToken: buildLiquidityAnalytics(manifest, poolReports) },
    loans: {
      status: "AVAILABLE",
      current: {
        pools: poolReports.length,
        scanned: poolReports.reduce((sum, pool) => sum + pool.loans.scanned, 0),
        outstanding: poolReports.reduce((sum, pool) => sum + pool.loans.outstanding, 0),
        repaid: poolReports.reduce((sum, pool) => sum + pool.loans.repaid, 0),
        expiredUnrepaid: poolReports.reduce((sum, pool) => sum + pool.loans.expiredUnrepaid, 0),
        committedLoanAmountByPool: Object.fromEntries(poolReports.map((pool) => [pool.id, pool.loans.committedLoanAmount])),
        settledRepaymentsByPool: Object.fromEntries(poolReports.map((pool) => [pool.id, pool.loans.settledRepayments])),
        defaultedCollateralByPool: Object.fromEntries(poolReports.map((pool) => [pool.id, pool.loans.defaultedCollateral])),
      },
      historicalTransactions: {
        borrow: [...poolTransactionCounts.values()].reduce((sum, count) => sum + count.borrow, 0),
        repay: [...poolTransactionCounts.values()].reduce((sum, count) => sum + count.repay, 0),
        byPool: Object.fromEntries([...poolTransactionCounts.entries()].map(([address, count]) => [address, count])),
      },
      borrowRecords,
    },
    fees: { status: "AVAILABLE", byToken: fees, claimedByToken: stringMap(claimedByToken) },
    rewards,
    portfolio: { status: "AVAILABLE", historicalOwners: lpPositions.historicalOwners, currentPositions: lpPositions.currentPositions, byLoanToken: portfolio, users },
    controllerActions,
  };
}

function display(report) {
  const { summary } = report;
  console.log(`VinuChain legacy reconciliation: ${summary.status} at block ${report.block.number}`);
  console.log(`RPC chain ${report.rpc.chainId}; pools ${summary.pools}/${report.pools.length}; errors ${summary.errors}; warnings ${summary.warnings}`);
  console.log(`LP inventory ${report.lpPositions.historicalOwners} historical owners; ${report.lpPositions.currentPositions} current positions`);
  console.log(`Analytics ${report.analytics.availability} via ${report.analytics.source.api} at block ${report.analytics.source.retrievalBlock}`);
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

export {
  ADD_LIQUIDITY_TOPIC,
  ANALYTICS_CONTROLLER_INTERFACE,
  ANALYTICS_POOL_INTERFACE,
  EXPLORER_MAX_PAGES,
  EXPLORER_MAX_TRANSACTIONS,
  LP_INTERFACE,
  NEW_SUB_POOL_INTERFACE,
  NEW_SUB_POOL_TOPIC,
  buildLiquidityAnalytics,
  decodeLpOwners,
  decodeTraceTransfers,
  keccak256,
  loadManifest,
  lpEntitlement,
  parseAnalyticsTransaction,
  readControllerAnalyticsEvents,
  readExplorerAddressTransactions,
  readExplorerTransactionTransfers,
  readLpOwnerEvents,
  readNewSubPoolEvents,
  resolveReadTag,
  safeExplorerApiUrl,
  safeRpcOrigin,
  validateExplorerAddressTransactionPage,
  validateExplorerTransferPage,
  validateManifest,
};

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
    if (!(() => { try { safeExplorerApiUrl("https://explorer-user:explorer-password@mainnet.vinuexplorer.org/api/v2?api_key=query-secret#fragment-secret"); return false; } catch (_error) { return true; } })()) throw new Error("Explorer credential URL was accepted");
    if (safeExplorerApiUrl("http://localhost:8545/api/v2") !== "http://localhost:8545/api/v2") throw new Error("Local Explorer URL self-check failed");
    if (!(() => { try { safeExplorerApiUrl("http://mainnet.vinuexplorer.org/api/v2"); return false; } catch (_error) { return true; } })()) throw new Error("Non-TLS Explorer URL was accepted");
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
  const lpPositions = await readLpPositions(rpc, manifest, pools, callTag, blockTimestamp, blockNumberHex, findings);
  let controllerAnalyticsEvents;
  try {
    controllerAnalyticsEvents = await readControllerAnalyticsEvents(rpc, manifest, blockNumberHex, findings);
  } catch (error) {
    addFinding(findings, "warning", "CONTROLLER_ANALYTICS_EVENTS_UNAVAILABLE", "controller.analyticsEvents", "bounded RPC event scan", error.message);
  }
  let analytics;
  try {
    if (!manifest.network.explorerApiUrl) throw new Error("Manifest does not provide network.explorerApiUrl");
    if (!controllerAnalyticsEvents) throw new Error("Controller analytics event scan was unavailable");
    if (args.block !== undefined) throw new Error("Explorer address transaction pages are head-indexed; exact historical analytics requires a block-indexed source");
    const explorer = new ExplorerClient(manifest.network.explorerApiUrl);
    analytics = await readAnalytics(rpc, explorer, manifest, block, callTag, pools, controllerState, controllerAnalyticsEvents, lpPositions, findings);
  } catch (error) {
    analytics = unavailableAnalytics(manifest, block, new Date().toISOString(), error.message);
    addFinding(findings, "warning", "ANALYTICS_UNAVAILABLE", "analytics", "complete bounded Explorer/RPC reconciliation", error.message);
  }
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
    lpPositions,
    controllerAnalyticsEvents,
    analytics,
    findings,
    knownRisks: manifest.knownRisks,
    summary: { status, analyticsStatus: analytics.status, analyticsAvailability: analytics.availability, pools: pools.length, currentLpPositions: lpPositions.currentPositions, errors, warnings, knownRiskCodes: [...knownRiskCodes] },
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
