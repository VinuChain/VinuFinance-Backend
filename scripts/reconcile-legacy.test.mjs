import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ADD_LIQUIDITY_TOPIC, LP_INTERFACE, NEW_SUB_POOL_INTERFACE, NEW_SUB_POOL_TOPIC, decodeLpOwners, keccak256, loadManifest, lpEntitlement, readLpOwnerEvents, readNewSubPoolEvents, resolveReadTag, safeRpcOrigin, validateManifest } from "./reconcile-legacy.mjs";

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
assert.ok(readFileSync(resolve(root, "deployments/vinuchain-legacy.json"), "utf8").includes("Panic(0x11)"));
assert.equal(lpEntitlement(10_000n, 1_000n, 10n, 3n), 2_700n);
assert.equal(lpEntitlement(1_000n, 1_000n, 0n, 0n), 0n);
assert.equal(lpEntitlement(999n, 1_000n, 0n, 0n), 0n);
assert.throws(() => lpEntitlement(999n, 1_000n, 1n, 1n), /reserved minimum/);

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
assert.equal(eventRequests[0].address, undefined);
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
assert.equal(unexpectedReport.records.length, 11);
assert.ok(unexpectedFindings.some((finding) => finding.code === "UNEXPECTED_NEW_SUBPOOL"));
assert.ok(unexpectedFindings.some((finding) => finding.code === "NEW_SUBPOOL_INVENTORY_MISMATCH"));

const lpOwner = "0x00000000000000000000000000000000000000a1";
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

console.log(`reconcile-legacy self-test passed: ${manifest.pools.length} pools, ${usdtPools.length} USDT pools, ${decimalMismatches.length} declared/token decimal mismatches`);
