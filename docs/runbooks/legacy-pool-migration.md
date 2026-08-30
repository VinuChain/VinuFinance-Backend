# Legacy pool migration, rollback, and monitoring

This runbook covers `legacy-mainnet-v1` only. The deployed BasePool bytecode is
immutable; changing source or frontend code does not repair an existing pool.
The read-only reconciler is the precondition for every step:

```bash
node scripts/reconcile-legacy.mjs --json
```

The RPC portion performs only `eth_chainId`, `eth_blockNumber`,
`eth_getBlockByNumber`, `eth_getCode`, bounded `eth_getLogs`, and read-only
`eth_call` requests. The report also uses the public HTTPS VinuExplorer v2
address-transaction and per-transaction token-transfer endpoints for the
fixed Controller plus ten legacy pool addresses. It has no signer,
private-key, token-transfer, governance, pause, or deployment capability.
Production Explorer requests are pinned to `https://mainnet.vinuexplorer.org`;
HTTP is accepted only for localhost test fixtures.

When `analytics.availability` is `AVAILABLE`, the report has exhausted and
schema-validated each bounded address page through the resolved current head.
It decodes successful pool `borrow`/`repay` calldata, proves each borrow's
collateral input and `input - collateralPledge` fee against token transfers to
the Controller, and cross-checks those fees against Controller snapshot and
current revenue. It also reports per-loan-token total/available/committed
liquidity and utilisation, current loan/default/repayment totals, historical
borrow/repay transaction counts, exact current LP portfolio entitlements (by
loan token and by LP address), and
Controller snapshot/claim/reward totals. `depositRewardSupply`,
`collectReward`, and direct `depositRevenue` calls are decoded when present.
The current deployment has no reward-supply deposits or collections, a
zero `rewardSupply()` read, and zero-valued `Reward` events; the report emits
that as an explicit proof rather than an inferred missing value.

The Explorer index is deliberately bounded (16 pages, 1,000 transactions per
address, 100 items per page, 2 MB response, and 64 KB calldata). A single
reconciliation also has a 2,000-request and 120-second network budget. A
malformed or oversized response, failed transfer/receipt read, unsupported
historical block, or provider failure returns
`analytics.availability: "UNAVAILABLE"`; unavailable
metrics are omitted and never converted to zero. If the Explorer transfer
endpoint fails, the reconciler uses read-only `trace_transaction` for the
specific already-discovered transaction and fails closed if that also fails.
Transfer rows must remain bound to their requested transaction, use the
manifest token decimals, and fit uint256 raw-value bounds; duplicate inventory
hashes and malformed Controller log metadata also fail closed.
Missing or invalid Explorer configuration is represented as `UNAVAILABLE`
without echoing the rejected URL.
The existing RPC state/event reconciliation remains independent of this
external index. This slice intentionally has a `ponytail:` ceiling at the
manifest's fixed legacy address set and VinuExplorer v2 schema; a new
deployment generation requires a new address registry and separately reviewed
provider/schema adapter.

This is a current-deployment analytics ledger, not a generic historical
claims-liability engine. It reports the bounded `Reward` and `TokenClaimed`
event totals and the exact current LP positions known by the reconciler; a
future deployment or a provider that cannot exhaust the fixed address pages
requires an independently reviewed archive/event source before declaring
claimable residuals settled.

For a mature current LP owner with non-empty `eth_getCode` at the pinned report
block, the reconciler does not forge a direct `from` address to prove an exit.
It reports exit reachability as unavailable and requires the owner contract's
actual executor path to be verified separately.

## Known legacy hazards

### USDT decimals

VinuChain USDT is `0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41` with **6
decimals**. The six USDT-collateral pools are:

- `0xfeec5A79D8f6d0CcC9f55Ed96cf985501CC4Db37` (declares 18; mismatch)
- `0x2Eb1970dc38AfF84735cf965126ec5044197285C` (declares 18; mismatch)
- `0xF0e98da5EF7CA6aD88E42cD3fc47546B10618F1b` (declares 6)
- `0x81FF52B811F13548782B4dfBff604045F4786dfb` (declares 6)
- `0x02C9888b942FC237f413d759663F4415FC8A80FB` (declares 6)
- `0x2111Bcd337dcbF62F02A93b758030673f0458fe9` (declares 6)

The frontend and migration tooling must use the token's on-chain `decimals()`
and the pool's declared value independently. Never normalize all six pools to
18 decimals and never rewrite historical raw amounts in place.

### Historical reward-claim panic

Pool `0x68EA6F302e1bFDEbCC6336e7309463c97c100a05`, loan index `1`, is an expired
unrepaid loan. A historical claim simulation against the legacy runtime
returns Solidity `Panic(0x11)` (arithmetic underflow). Do not blind-retry this
claim, auto-reinvest it, or tell an LP that a failed simulation settled a
claim. Preserve the raw loan/LP state, record the failed calldata simulation,
and escalate to the migration owner.

## Migration plan

The following actions require the named external deployer/governance authority;
the repository scripts do not execute them.

1. **Freeze the release surface.** Keep legacy pools visible as legacy, disable
   new borrowing where governance policy requires, and show the decimal and
   claim-risk notices. Do not remove LP or borrower history.
2. **Snapshot before migration.** Run the reconciler at a head block and, when
   available, an archive RPC at the exact cutover block. Export each pool's
   config, bytecode hash, total liquidity, LP shares, next loan index, every
   loan state, claims, reward state, controller balances/revenue, whitelist,
   pause state, and the RPC block hash. Store raw integers and token decimals.
3. **Deploy the fixed generation on testnet.** Use the audited source and exact
   constructor manifest. Verify bytecode, constructors, token decimals, pool
   registration, pause controls, reward coefficients, and the complete
   repay/default/claim/emergency paths. Rehearse LP exit and borrower repayment
   with realistic six-decimal USDT and non-standard-token rejection tests.
4. **Obtain governance approval.** The Controller veto holder and the required
   voting authority must approve any legacy pause/whitelist changes and the new
   pool generation. Record proposal IDs, receipts, post-state reads, and the
   authority responsible for each action.
5. **Settle or migrate positions deliberately.** There is no generic contract
   state-copy method. Process eligible repayments, default claims, and LP
   withdrawals with user-authorized, bounded transactions. For the known
   `Panic(0x11)` claim, use a reviewed migration procedure or an explicit
   governance-approved recovery contract; never fabricate a successful claim.
6. **Seed and verify the replacement pools.** Fund only after all constructor,
   bytecode, whitelist, decimals, pause, balance, and ownership checks pass.
   Reconcile post-state against the pre-migration snapshot and require an
   independent reviewer to sign the diff.
7. **Switch the frontend atomically.** Publish the new address/ABI registry and
   generation marker only after the replacement read-only health check passes.
   Keep legacy addresses available for history and rollback visibility.

## Rollback

Rollback is a release/configuration action, not a contract upgrade:

1. Stop new frontend submissions to the replacement generation and display a
   maintenance/settlement state.
2. Repoint the frontend to the last validated address registry, preserving the
   legacy generation marker and raw position history.
3. Do not destroy, self-destruct, or transfer funds from either generation as
   part of rollback. Re-run the reconciler and compare code hashes, whitelist,
   balances, loan states, and controller revenue before reopening any action.
4. If funds or claims do not reconcile, keep borrowing disabled and escalate to
   the governance/security authority. The emergency helper may be used only
   through its explicit user approval and approved escrow path.

## Monitoring

Run `reconcile-legacy.mjs --json` on a short fixed interval (for example, five
minutes) from an isolated read-only worker. Alert on:

- RPC failure, wrong chain, missing code, runtime-byte or runtime-hash drift;
- a pool no longer whitelisted, unexpected pause state, config mismatch, or
  loan scan cap exhaustion;
- loan-token balance below `totalLiquidity`;
- changes to outstanding/repaid/expired loan counts, committed principal,
  settled repayments, default collateral, active/expired collateral, remaining
  default collateral, or claimed default collateral;
- controller revenue/balance changes, analytics becoming unavailable, non-zero
  reward supply, reward deposits/collections, non-zero Reward totals, or a
  fee/input/Controller-revenue mismatch. Also alert on repayment reserve or
  claimed/reinvested repayment changes;
- any USDT decimal mismatch beyond the two explicitly recorded legacy pools;
- frontend generation/address/ABI hash not matching the release registry.

Retain the JSON report, RPC endpoint identifier, block number/hash, and release
SHA for every alert. Never log RPC credentials, private keys, wallet seeds,
transaction signing material, or raw environment files.
