# Security Findings & Reward-Bookkeeping Invariant Spec

This document records the outcome of the audit-remediation work on the reward
bookkeeping added to `BasePool`, and writes down the invariant the subsystem is
*supposed* to satisfy (audit findings S1 and A3). It is descriptive: no
deployed-contract semantics were changed by this work.

Source audit: `reports/vinuchain-audit-2026-06-10/05-VinuFinance-Backend.md`.

---

## S1 — Reward non-underflow invariant: **FALSIFIED**

### The intended invariant

`lastTrackedLiquidity[a]` is a per-LP counter the reward subsystem subtracts from
on exit. For the bookkeeping never to block a fund movement, it must hold that at
every decrement site:

- `removeLiquidity` (`BasePool.sol:252`): `lastTrackedLiquidity[a] >= liquidityRemoved`
- `claim` (`BasePool.sol:437`): `lastTrackedLiquidity[a] >= claimInfo.loanAmount`

Under Solidity 0.8 checked arithmetic, a violation reverts the whole call and
**locks the LP's position** (cannot remove or claim).

### Verdict: the invariant does NOT hold

A stateful Foundry invariant fuzzer (`test/foundry/RewardInvariant.t.sol`) finds a
short sequence that violates the `removeLiquidity` decrement. The minimal,
deterministic reproduction is in `test/foundry/RewardUnderflowRepro.t.sol` and
asserts the real on-chain `Panic(0x11)` revert.

#### Why it drifts (root cause = audit A3)

`lastTrackedLiquidity[a]` is credited with the LP's **raw principal** deposits
(`BasePool.sol:194`, `+ _sendAmount`). But the exit decrement is the
**share-proportional value** of the position against the *current* pool
(`BasePool.sol:244-245`):

```
liquidityRemoved = numShares * (totalLiquidity - minLiquidity) / totalLpShares
```

`totalLiquidity` / `totalLpShares` — the per-share value — moves over time:

- it **rises** when later LPs add at a different share price, and when a partial
  removal burns shares while leaving the `minLiquidity` buffer behind
  (concentrating value into the remaining shares);
- it **rises** further as repayments credit accrued interest into the pool.

The tracker never follows those movements. Once the per-share value has risen
enough, an early small LP's `liquidityRemoved` exceeds its principal-only tracker
and the subtraction underflows.

#### Concrete reproduction (from the fuzzer's shrunk counterexample)

| Step | Action | Effect |
|---|---|---|
| 1 | LP_SEED adds 5002 | pool seeded above `minLiquidity` |
| 2 | LP_SMALL adds 31 | `lastTrackedLiquidity[LP_SMALL] = 31`, gets 6 shares |
| 3 | LP_SEED removes 614 shares | returns only 20 liquidity but burns 614 shares → per-share value jumps (`totalLiquidity=5013`, `totalLpShares=392`) |
| 4 | LP_BIG adds 6338 | `totalLiquidity=11351`, `totalLpShares=887` |
| 5 | LP_SMALL removes its 6 shares | `liquidityRemoved = 6*(11351-5000)/887 = 42` > tracker `31` → **revert at line 252** |

LP_SMALL is now locked out of `removeLiquidity` for this position state.

### Claim side (`BasePool.sol:437`)

The `claim` decrement uses the identical unguarded pattern
(`lastTrackedLiquidity[a] - claimInfo.loanAmount`) and is therefore *theoretically*
vulnerable to the same drift. Across the realistic add/remove/borrow/repay/claim/
reinvest sequences the harness explored, the fuzzer did **not** reach a claim-side
underflow (claims occur within constant-share intervals whose tracker was set
consistently). `test/foundry/RewardInvariant.t.sol` keeps an *active* regression
guard (`invariant_claimNeverRevertsFromRewardUnderflow`) that turns red if a future
change makes the claim site reachable.

### Recommended fix (audit task P2) — owner decision required

Make the two decrements **saturating** (floor at zero) so reward bookkeeping can
never block a fund movement:

```solidity
// at BasePool.sol:252 and :437, instead of `tracked - amt`:
uint256 newLiq = tracked > amt ? tracked - amt : 0;
```

Trade-off: this slightly under-credits rewards at the boundary (reward is computed
on `lastTrackedLiquidity`, which would floor at 0), but never traps funds — the
audit's stated acceptable trade-off. This is a **deployed-semantics change** and was
intentionally NOT applied here; it requires owner sign-off. After applying it,
delete the `vm.skip(true)` in `invariant_exitNeverRevertsFromRewardUnderflow` so the
invariant becomes a live guard, and re-run the full suite.

> NOTE: the same `removeLiquidity` path also has an *inherited MYSO-core* underflow
> at `BasePool.sol:245` (`totalLiquidity - minLiquidity`) when a pool's
> `totalLiquidity` is allowed to fall below `minLiquidity` (possible because the
> first add to an empty pool only needs `>= minLiquidity/1000`). This is a
> pre-existing core property, tracked separately by the harness
> (`coreLine245UnderflowSeen`) and explicitly NOT folded into the S1 verdict.

---

## Test inventory added by this work

| File | Purpose |
|---|---|
| `foundry.toml` | Foundry profile for the security harness (Hardhat remains the canonical toolchain) |
| `test/foundry/mocks/MockRewardController.sol` | Minimal `IController` stub mirroring the reward distribution arithmetic |
| `test/foundry/RewardInvariant.handler.sol` | Stateful fuzz handler (add/remove/borrow/repay/claim/reinvest/warp) with precise underflow attribution |
| `test/foundry/RewardInvariant.t.sol` | Invariants: S1 (skipped, falsified), claim-side guard, reward conservation (P4), deterministic replay |
| `test/foundry/RewardUnderflowRepro.t.sol` | Minimal deterministic repro asserting the real revert |

Run: `npm run test:foundry` (after `forge install --no-git foundry-rs/forge-std`).

## Non-zero reward coefficient (audit finding T1)

The inherited core suite historically ran with `REWARD_COEFFICIENT='0'`, so the
reward *amounts* were always zero across the ~150 share-array edge-case tests.
`test/pool.spec.ts` now reads the coefficient from the `REWARD_COEFFICIENT` env var
(default `'0'`), and CI runs the suite twice (0 and `1e15`) so the bookkeeping
side-effects are exercised under live rewards across every scenario.
