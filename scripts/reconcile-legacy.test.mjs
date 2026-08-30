import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, loadManifest, resolveReadTag, validateManifest } from "./reconcile-legacy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = validateManifest(loadManifest(resolve(root, "deployments/vinuchain-legacy.json")));

assert.equal(keccak256(Buffer.alloc(0)), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
assert.equal(keccak256(Buffer.from("abc")), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
assert.equal(manifest.network.chainId, 207);
assert.equal(resolveReadTag(undefined, "0xab"), "0xab");
assert.equal(resolveReadTag("42", "0x2a"), "0x2a");
assert.deepEqual(manifest.network.forkRulesAtObservation, {
  query: "vc_getRules latest",
  Shanghai: true,
  Cancun: true,
  Prague: true,
  VinuLatestEVM: true,
});
assert.equal(manifest.pools.length, 10);
assert.equal(new Set(manifest.pools.map((pool) => pool.address.toLowerCase())).size, 10);
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
assert.ok(readFileSync(resolve(root, "deployments/vinuchain-legacy.json"), "utf8").includes("Panic(0x11)"));

console.log(`reconcile-legacy self-test passed: ${manifest.pools.length} pools, ${usdtPools.length} USDT pools, ${decimalMismatches.length} declared/token decimal mismatches`);
