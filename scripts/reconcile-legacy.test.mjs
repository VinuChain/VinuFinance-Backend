import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADD_LIQUIDITY_TOPIC,
  ANALYTICS_CONTROLLER_INTERFACE,
  ANALYTICS_POOL_INTERFACE,
  createAnalyticsBudget,
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
  simulateLpExit,
  unavailableAnalytics,
  validateExplorerAddressTransactionPage,
  validateExplorerTransferPage,
  validateManifest,
} from "./reconcile-legacy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = validateManifest(loadManifest(resolve(root, "deployments/vinuchain-legacy.json")));

assert.equal(keccak256(Buffer.alloc(0)), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
assert.equal(keccak256(Buffer.from("abc")), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
assert.equal(manifest.network.chainId, 207);
assert.equal(manifest.network.eventScanStartBlock, 100000);
assert.equal(manifest.network.observedBlock, 14707477);
assert.equal(manifest.network.observedBlockTimestamp, 1788069122);
assert.equal(resolveReadTag(undefined, "0xab"), "0xab");
assert.equal(resolveReadTag("42", "0x2a"), "0x2a");
assert.deepEqual(manifest.network.forkRulesAtLatest, {
  query: "vc_getRules latest",
  Shanghai: true,
  Cancun: true,
  Prague: true,
  VinuLatestEVM: true,
});
assert.equal(manifest.pools.length, 10);
assert.equal(new Set(manifest.pools.map((pool) => pool.address.toLowerCase())).size, 10);
assert.ok(manifest.pools.every((pool) => pool.sourceVerification === "NONE"));
assert.equal(manifest.tokens.usdt.decimals, 6);
const usdtPools = manifest.pools.filter((pool) => pool.collateralToken === "usdt");
assert.equal(usdtPools.length, 6);
const decimalMismatches = usdtPools.filter((pool) => pool.declaredCollateralDecimals !== manifest.tokens[pool.collateralToken].decimals);
assert.equal(decimalMismatches.length, 2);
const runtimeHashes = [
  ...Object.values(manifest.contracts),
  ...Object.values(manifest.tokens),
  ...manifest.pools,
].map((item) => item.runtimeKeccak);
assert.ok(runtimeHashes.every((hash) => /^0x[0-9a-f]{64}$/.test(hash)), "runtime hashes must be lowercase normalized hex");
assert.equal(manifest.contracts.controller.address.toLowerCase(), "0x17ba239f2815ba01152522521737275a2439216f");
assert.equal(manifest.observedLoans.find((loan) => loan.pool.toLowerCase() === "0xb8f54383b78fab60d2ecedc59b5cde9a6ae655d1" && loan.loanIdx === 1).borrower, "0x9ceaab056d465812c9e0edce6f0f24f4d99ee79a");
assert.equal(safeRpcOrigin("https://rpc-user:rpc-password@rpc.vinuchain.org/private/secret?api_key=query-secret#fragment-secret"), "https://rpc.vinuchain.org");
assert.throws(() => safeExplorerApiUrl("https://explorer-user:explorer-password@mainnet.vinuexplorer.org/api/v2?api_key=query-secret#fragment-secret"), /credentials/);
assert.equal(safeExplorerApiUrl("http://localhost:8545/api/v2"), "http://localhost:8545/api/v2");
assert.throws(() => safeExplorerApiUrl("http://mainnet.vinuexplorer.org/api/v2"), /pinned production origin/);
assert.equal(safeExplorerApiUrl("https://mainnet.vinuexplorer.org/api/v2"), "https://mainnet.vinuexplorer.org/api/v2");
assert.throws(() => safeExplorerApiUrl("https://example.com/api/v2"), /pinned production origin/);
const unavailableSource = unavailableAnalytics(
  { network: {}, contracts: { controller: { address: manifest.contracts.controller.address } }, pools: [] },
  { number: 1, hash: `0x${"55".repeat(32)}` },
  "2026-08-31T00:00:00.000Z",
  "Explorer URL missing",
);
assert.equal(unavailableSource.availability, "UNAVAILABLE");
assert.equal(unavailableSource.source.apiBaseUrl, null);
assert.throws(() => createAnalyticsBudget(0), /positive integer/);
assert.throws(() => createAnalyticsBudget(1, 0), /positive integer/);
assert.ok(readFileSync(resolve(root, "deployments/vinuchain-legacy.json"), "utf8").includes("Panic(0x11)"));
assert.equal(lpEntitlement(10_000n, 1_000n, 10n, 3n), 2_700n);
assert.equal(lpEntitlement(1_000n, 1_000n, 0n, 0n), 0n);
assert.equal(lpEntitlement(999n, 1_000n, 0n, 0n), 0n);
assert.throws(() => lpEntitlement(999n, 1_000n, 1n, 1n), /reserved minimum/);

const liquidityAnalytics = buildLiquidityAnalytics(
  { tokens: { loan: { address: manifest.tokens.wvc.address, symbol: "WVC", decimals: 18 } } },
  [{
    id: "pool",
    config: { loanToken: manifest.tokens.wvc.address, totalLiquidity: "500", minLiquidity: "100" },
    loans: { committedLoanAmount: "300" },
    settlement: { scanComplete: true },
  }],
);
assert.equal(liquidityAnalytics[0].availableLiquidity, "400");
assert.equal(liquidityAnalytics[0].committedLiquidity, "300");
assert.equal(liquidityAnalytics[0].utilizationBps, "4285");

const eventLogs = manifest.pools.map((pool) => {
  const encoded = NEW_SUB_POOL_INTERFACE.encodeEventLog(NEW_SUB_POOL_INTERFACE.getEvent("NewSubPool"), [
    manifest.tokens[pool.loanToken].address,
    manifest.tokens[pool.collateralToken].address,
    pool.config.loanTenor,
    pool.config.maxLoanPerColl,
    pool.config.r1,
    pool.config.r2,
    pool.config.liquidityBnd1,
    pool.config.liquidityBnd2,
    pool.config.minLoan,
    pool.config.creatorFee,
    manifest.contracts.controller.address,
    pool.config.rewardCoefficient,
  ]);
  return {
    address: pool.address,
    blockNumber: `0x${pool.creationBlock.toString(16)}`,
    transactionHash: pool.creationTxHash,
    topics: encoded.topics,
    data: encoded.data,
  };
});
const foreignEncoded = NEW_SUB_POOL_INTERFACE.encodeEventLog(NEW_SUB_POOL_INTERFACE.getEvent("NewSubPool"), [
  manifest.tokens[manifest.pools[0].loanToken].address,
  manifest.tokens[manifest.pools[0].collateralToken].address,
  manifest.pools[0].config.loanTenor,
  manifest.pools[0].config.maxLoanPerColl,
  manifest.pools[0].config.r1,
  manifest.pools[0].config.r2,
  manifest.pools[0].config.liquidityBnd1,
  manifest.pools[0].config.liquidityBnd2,
  manifest.pools[0].config.minLoan,
  manifest.pools[0].config.creatorFee,
  "0x00000000000000000000000000000000000000ff",
  manifest.pools[0].config.rewardCoefficient,
]);
const foreignControllerLog = { ...eventLogs[0], address: "0x0000000000000000000000000000000000000001", topics: foreignEncoded.topics, data: foreignEncoded.data };
const unexpectedControllerLog = { ...eventLogs[0], address: "0x0000000000000000000000000000000000000002" };
const eventRequests = [];
const eventFindings = [];
const fakeRpc = {
  async request(method, params) {
    assert.equal(method, "eth_getLogs");
    eventRequests.push(params[0]);
    return params[0].fromBlock === "0x186a0" ? [...eventLogs, foreignControllerLog] : [];
  },
};
const eventReport = await readNewSubPoolEvents(fakeRpc, manifest, "0x80000", eventFindings);
assert.equal(eventFindings.length, 0);
assert.equal(eventReport.records.length, 10);
assert.equal(eventReport.chunks, 5);
assert.deepEqual(eventRequests[0].address, manifest.pools.map((pool) => pool.address));
assert.ok(eventRequests.every((filter) => filter.topics[0] === NEW_SUB_POOL_TOPIC));
assert.ok(eventRequests.every((filter) => filter.toBlock !== "latest"));
const unexpectedFindings = [];
const unexpectedRpc = {
  async request(method, params) {
    assert.equal(method, "eth_getLogs");
    return params[0].fromBlock === "0x186a0" ? [...eventLogs, foreignControllerLog, unexpectedControllerLog] : [];
  },
};
const unexpectedReport = await readNewSubPoolEvents(unexpectedRpc, manifest, "0x80000", unexpectedFindings);
assert.equal(unexpectedReport.records.length, 10);
assert.equal(unexpectedFindings.length, 0);

const lpOwner = "0x00000000000000000000000000000000000000a1";
const controllerEventEncoded = ANALYTICS_CONTROLLER_INTERFACE.encodeEventLog(ANALYTICS_CONTROLLER_INTERFACE.getEvent("Reward"), [
  lpOwner,
  1,
  2,
  3,
  4,
]);
const controllerEventLog = {
  address: manifest.contracts.controller.address,
  blockNumber: "0x186a0",
  blockHash: `0x${"22".repeat(32)}`,
  transactionHash: `0x${"33".repeat(32)}`,
  logIndex: "0x0",
  topics: controllerEventEncoded.topics,
  data: controllerEventEncoded.data,
};
const controllerEventRpc = {
  async request(method, params) {
    assert.equal(method, "eth_getLogs");
    return params[0].fromBlock === "0x186a0" ? [controllerEventLog] : [];
  },
};
const controllerEventFindings = [];
const controllerEvents = await readControllerAnalyticsEvents(controllerEventRpc, manifest, "0x186a1", controllerEventFindings);
assert.equal(controllerEventFindings.length, 0);
assert.equal(controllerEvents.rewards.length, 1);
const foreignControllerEventFindings = [];
await assert.rejects(
  () => readControllerAnalyticsEvents({ request: async () => [{ ...controllerEventLog, address: "0x0000000000000000000000000000000000000001" }] }, manifest, "0x186a1", foreignControllerEventFindings),
  /unexpected emitter/,
);
assert.equal(foreignControllerEventFindings[0].code, "CONTROLLER_ANALYTICS_EVENT_DECODE_FAILED");
const malformedControllerEventFindings = [];
await assert.rejects(
  () => readControllerAnalyticsEvents({ request: async () => [{ ...controllerEventLog, transactionHash: "0x123" }] }, manifest, "0x186a1", malformedControllerEventFindings),
  /transactionHash is invalid/,
);
assert.equal(malformedControllerEventFindings[0].code, "CONTROLLER_ANALYTICS_EVENT_DECODE_FAILED");
await assert.rejects(
  () => readControllerAnalyticsEvents({ request: async () => [{ ...controllerEventLog, removed: "true" }] }, manifest, "0x186a1", []),
  /removed is invalid/,
);
const duplicateControllerEventFindings = [];
await assert.rejects(
  () => readControllerAnalyticsEvents({ request: async () => [controllerEventLog, controllerEventLog] }, manifest, "0x186a1", duplicateControllerEventFindings),
  /returned more than once/,
);
assert.equal(duplicateControllerEventFindings[0].code, "CONTROLLER_ANALYTICS_EVENT_DECODE_FAILED");

const addEncoded = LP_INTERFACE.encodeEventLog(LP_INTERFACE.getEvent("AddLiquidity"), [
  lpOwner,
  10_000,
  2_000,
  10_000,
  2_000,
  100,
  1,
  0,
]);
const addLog = {
  address: manifest.pools[0].address,
  blockNumber: "0x20000",
  transactionHash: `0x${"11".repeat(32)}`,
  topics: addEncoded.topics,
  data: addEncoded.data,
};
const lpDecodeFindings = [];
const decodedOwners = decodeLpOwners([addLog, addLog], manifest, lpDecodeFindings);
assert.equal(lpDecodeFindings.length, 0);
assert.equal(decodedOwners.records, 2);
assert.deepEqual([...decodedOwners.owners.get(manifest.pools[0].address.toLowerCase())], [lpOwner]);

const lpRequests = [];
const lpEventRpc = {
  async request(method, params) {
    assert.equal(method, "eth_getLogs");
    lpRequests.push(params[0]);
    return params[0].fromBlock === "0x186a0" ? [addLog] : [];
  },
};
const lpEventFindings = [];
const lpEventReport = await readLpOwnerEvents(lpEventRpc, manifest, "0x80000", lpEventFindings);
assert.equal(lpEventFindings.length, 0);
assert.equal(lpEventReport.records, 1);
assert.equal(lpEventReport.chunks, 5);
assert.ok(lpRequests.every((request) => request.topics[0] === ADD_LIQUIDITY_TOPIC));
assert.ok(lpRequests.every((request) => request.address.length === 10));
assert.ok(lpRequests.every((request) => request.toBlock !== "latest"));

const contractOwner = "0x00000000000000000000000000000000000000b2";
const contractExitRequests = [];
const contractExitFindings = [];
const contractExit = await simulateLpExit({
  async request(method, params) {
    contractExitRequests.push({ method, params });
    return "0x60006000";
  },
}, contractOwner, manifest.pools[0].address, 10n, 100n, 200n, "0xc8", "pool.contract-owner", contractExitFindings);
assert.equal(contractExit.status, "UNAVAILABLE");
assert.equal(contractExitRequests.length, 1);
assert.equal(contractExitRequests[0].method, "eth_getCode");
assert.equal(contractExitRequests[0].params[1], "0xc8");
assert.equal(contractExitFindings[0].code, "LP_CONTRACT_OWNER_EXIT_UNAVAILABLE");
assert.equal(contractExitFindings[0].actual, "non-empty bytecode");
const eoaExitRequests = [];
const eoaExit = await simulateLpExit({
  async request(method, params) {
    eoaExitRequests.push({ method, params });
    return "0x";
  },
}, lpOwner, manifest.pools[0].address, 10n, 100n, 200n, "0xc8", "pool.eoa-owner", []);
assert.equal(eoaExit.status, "SUCCESS");
assert.deepEqual(eoaExitRequests.map((request) => request.method), ["eth_getCode", "eth_call"]);

const txHash = `0x${"22".repeat(32)}`;
const explorerAddress = manifest.contracts.controller.address;
const decodedBorrow = parseAnalyticsTransaction(ANALYTICS_POOL_INTERFACE, {
  raw_input: ANALYTICS_POOL_INTERFACE.encodeFunctionData("borrow", [explorerAddress, 300, 200, 100, 7, 8]),
});
assert.equal(decodedBorrow.name, "borrow");
assert.equal(decodedBorrow.args[1].toString(), "300");
assert.equal(parseAnalyticsTransaction(ANALYTICS_CONTROLLER_INTERFACE, {
  raw_input: ANALYTICS_CONTROLLER_INTERFACE.encodeFunctionData("depositRewardSupply", [9]),
}).name, "depositRewardSupply");
assert.equal(parseAnalyticsTransaction(ANALYTICS_CONTROLLER_INTERFACE, {
  raw_input: ANALYTICS_CONTROLLER_INTERFACE.encodeFunctionData("collectReward", [false]),
}).name, "collectReward");
const validExplorerTransaction = {
  hash: txHash,
  block_number: 14700000,
  raw_input: "0x",
  result: "success",
  from: { hash: lpOwner },
  to: { hash: explorerAddress },
};
assert.deepEqual(validateExplorerAddressTransactionPage({ items: [validExplorerTransaction], next_page_params: null }).items, [validExplorerTransaction]);
assert.throws(() => validateExplorerAddressTransactionPage({ items: [{ ...validExplorerTransaction, raw_input: "0x0" }], next_page_params: null }), /raw_input/);
assert.throws(() => validateExplorerAddressTransactionPage({ items: [validExplorerTransaction], next_page_params: {} }), /next_page_params/);
assert.throws(() => validateExplorerAddressTransactionPage({ items: Array.from({ length: 101 }, () => validExplorerTransaction), next_page_params: null }), /exceeds/);

const pagedExplorer = {
  calls: 0,
  async addressTransactions() {
    this.calls += 1;
    return this.calls === 1
      ? { items: [validExplorerTransaction], next_page_params: { block_number: "14700000", index: "1" } }
      : { items: [], next_page_params: null };
  },
};
const pagedReport = await readExplorerAddressTransactions(pagedExplorer, explorerAddress);
assert.equal(pagedReport.pages, 2);
assert.equal(pagedReport.transactions.length, 1);
assert.equal(pagedReport.address, explorerAddress.toLowerCase());
await assert.rejects(
  () => readExplorerAddressTransactions({
    calls: 0,
    async addressTransactions() {
      this.calls += 1;
      return this.calls === 1
        ? { items: [validExplorerTransaction], next_page_params: { block_number: "14700000", index: "1" } }
        : { items: [], next_page_params: null };
    },
  }, explorerAddress, { budget: createAnalyticsBudget(1, 10_000) }),
  /request budget/,
);
await assert.rejects(
  () => readExplorerAddressTransactions({ addressTransactions: async () => ({ items: [validExplorerTransaction, validExplorerTransaction], next_page_params: null }) }, explorerAddress, { maxTransactions: 2 }),
  /returned more than once/,
);
await assert.rejects(
  () => readExplorerAddressTransactions({ addressTransactions: async () => ({ items: [validExplorerTransaction, validExplorerTransaction], next_page_params: null }) }, explorerAddress, { maxTransactions: 1 }),
  /transaction cap/,
);
await assert.rejects(
  () => readExplorerAddressTransactions({ addressTransactions: async () => ({ items: [validExplorerTransaction], next_page_params: { block_number: "1" } }) }, explorerAddress, { maxPages: 1 }),
  /page cap/,
);
await assert.rejects(
  () => readExplorerAddressTransactions({ addressTransactions: async () => { throw new Error("upstream unavailable"); } }, explorerAddress),
  /upstream unavailable/,
);

const transfer = {
  transaction_hash: txHash,
  log_index: "0",
  from: { hash: lpOwner },
  to: { hash: explorerAddress },
  token: { address: manifest.tokens.wvc.address },
  total: { value: "123", decimals: "18" },
};
const expectedTokenDecimals = new Map([[manifest.tokens.wvc.address.toLowerCase(), 18]]);
assert.deepEqual(validateExplorerTransferPage({ items: [transfer], next_page_params: null }, expectedTokenDecimals).items, [transfer]);
assert.throws(() => validateExplorerTransferPage({ items: [{ ...transfer, total: { value: "-1", decimals: "18" } }], next_page_params: null }), /total/);
assert.throws(() => validateExplorerTransferPage({ items: [{ ...transfer, total: { value: "123", decimals: "6" } }], next_page_params: null }, expectedTokenDecimals), /decimals/);
assert.throws(() => validateExplorerTransferPage({ items: [{ ...transfer, total: { value: "9".repeat(79), decimals: "18" } }], next_page_params: null }), /total/);
const transferClient = {
  calls: 0,
  async transactionTransfers() {
    this.calls += 1;
    return this.calls === 1 ? { items: [transfer], next_page_params: null } : { items: [], next_page_params: null };
  },
};
const transferReport = await readExplorerTransactionTransfers(transferClient, txHash);
assert.equal(transferReport.transfers.length, 1);
await assert.rejects(
  () => readExplorerTransactionTransfers({ transactionTransfers: async () => ({ items: [{ ...transfer, transaction_hash: `0x${"44".repeat(32)}` }], next_page_params: null }) }, txHash),
  /not bound to transaction/,
);
await assert.rejects(
  () => readExplorerTransactionTransfers({ transactionTransfers: async () => ({ items: [transfer, transfer], next_page_params: null }) }, txHash, { maxTransactions: 2 }),
  /returned more than once/,
);
await assert.rejects(
  () => readExplorerTransactionTransfers({ transactionTransfers: async () => ({ items: [transfer, transfer], next_page_params: null }) }, txHash, { maxTransactions: 1 }),
  /transfer cap/,
);

const traceToken = manifest.tokens.wvc.address;
const traceFrom = lpOwner;
const traceTo = explorerAddress;
const transferTraceInput = `0x${"a9059cbb"}${"0".repeat(24)}${traceTo.slice(2)}${"0".repeat(62)}7b`;
const transferFromTraceInput = `0x${"23b872dd"}${"0".repeat(24)}${traceFrom.slice(2)}${"0".repeat(24)}${traceTo.slice(2)}${"0".repeat(62)}7b`;
const traceTransfers = decodeTraceTransfers([
  { type: "call", action: { from: explorerAddress, to: traceToken, input: transferTraceInput } },
  { type: "call", action: { from: explorerAddress, to: traceToken, input: transferFromTraceInput } },
  { type: "call", error: "execution reverted", action: { from: explorerAddress, to: traceToken, input: transferTraceInput } },
]);
assert.equal(traceTransfers.length, 2);
assert.equal(traceTransfers[0].to, traceTo.toLowerCase());
assert.equal(traceTransfers[1].from, traceFrom.toLowerCase());

console.log(`reconcile-legacy self-test passed: ${manifest.pools.length} pools, ${usdtPools.length} USDT pools, ${decimalMismatches.length} declared/token decimal mismatches`);
