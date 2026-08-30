# Legacy pool migration, rollback, and monitoring

This runbook covers `legacy-mainnet-v1` only. The deployed BasePool bytecode is
immutable; changing source or frontend code does not repair an existing pool.
The read-only reconciler is the precondition for every step:

```bash
node scripts/reconcile-legacy.mjs --json
```

It performs only `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`,
`eth_getCode`, and read-only `eth_call` requests. It has no signer, private-key,
token-transfer, governance, pause, or deployment capability.

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
  settled repayments, default collateral, or claimable residuals;
- controller revenue/balance changes, reward events, or non-zero coefficients;
- any USDT decimal mismatch beyond the two explicitly recorded legacy pools;
- frontend generation/address/ABI hash not matching the release registry.

Retain the JSON report, RPC endpoint identifier, block number/hash, and release
SHA for every alert. Never log RPC credentials, private keys, wallet seeds,
transaction signing material, or raw environment files.
