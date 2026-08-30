# Security Findings & Reward-Bookkeeping Invariant Spec

This document records the outcome of the audit-remediation work on the reward
bookkeeping added to `BasePool`, and writes down the invariant the subsystem is
*supposed* to satisfy (audit findings S1 and A3).

Source audit: `reports/vinuchain-audit-2026-06-10/05-VinuFinance-Backend.md`.
Compiler and toolchain versions mentioned in the historical reproduction below
describe the original audit environment; the current reproducible build is
solc 0.8.36 with Cancun, optimizer runs 200, and Yul enabled in both Hardhat
and Foundry.

> **STATUS: S1 FIXED.** The saturating-subtraction remediation (audit task P2) has
> been applied to the two reward-tracker decrements in `BasePool` (`removeLiquidity`
> and `claim`). The previously-falsifying invariant is now a live, green guard. This
> change **does** alter deployed-contract semantics and is **committed, NOT pushed**
> — it requires owner review and a deliberate deploy. See "Fix applied" below.

---

## S1 — Reward non-underflow invariant: **FIXED** (was FALSIFIED)

### The intended invariant

`lastTrackedLiquidity[a]` is a per-LP counter the reward subsystem subtracts from
on exit. For the bookkeeping never to block a fund movement, it must hold that at
every decrement site:

- `removeLiquidity` (`BasePool.sol:252`): `lastTrackedLiquidity[a] >= liquidityRemoved`
- `claim` (`BasePool.sol:437`): `lastTrackedLiquidity[a] >= claimInfo.loanAmount`

Under Solidity 0.8 checked arithmetic, a violation reverts the whole call and
**locks the LP's position** (cannot remove or claim).

### Verdict: the invariant did NOT hold (pre-fix); the fix below restores it

A stateful Foundry invariant fuzzer (`test/foundry/RewardInvariant.t.sol`) found a
short sequence that violated the `removeLiquidity` decrement. The minimal,
deterministic reproduction is in `test/foundry/RewardUnderflowRepro.t.sol`. With the
fix applied, that reproduction now asserts the LP can withdraw (no revert), and the
invariant `invariant_exitNeverRevertsFromRewardUnderflow` is a live green guard.

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

### Fix applied (audit task P2) — committed, NOT pushed; needs owner review + deploy

The two decrements are now **saturating** (floor at zero) via a single internal
helper `_satSub(a, b) => a > b ? a - b : 0`, so reward bookkeeping can never block a
fund movement:

```solidity
// BasePool.sol — new helper:
function _satSub(uint256 a, uint256 b) internal pure returns (uint256) {
    return a > b ? a - b : 0;
}

// removeLiquidity (was: lastTrackedLiquidity[_onBehalfOf] - liquidityRemoved):
_updateRewardAndSend(_onBehalfOf, _satSub(lastTrackedLiquidity[_onBehalfOf], liquidityRemoved));

// claim (was: lastTrackedLiquidity[_onBehalfOf] - claimInfo.loanAmount):
(uint128 lastLiquidity, uint32 timeSinceLastReward) =
    _updateReward(_onBehalfOf, _satSub(lastTrackedLiquidity[_onBehalfOf], claimInfo.loanAmount));
```

(The helper form was chosen over an inline ternary because an inline ternary at the
`claim` site introduced an extra stack slot that tripped `Stack too deep` under the
project's historical non-via-IR Solc 0.8.19 profile. The helper consumes no caller stack slot.)

**Flooring at zero does NOT enable over-crediting.** The reward actually sent is
computed on the *old* tracker value (captured as `oldLiquidity` in `_updateReward`
*before* this subtraction writes the new value) times the elapsed interval. The
saturating subtraction only sets the *next* interval's base, and 0 is the smallest
possible base, so it can only ever *under*-credit a future interval — never inflate
`_liquidity` beyond pool inflow. This is verified live by
`invariant_rewardLiquidityNeverExceedsInflow` (the non-tautological over-crediting
bound), which stays green post-fix.

Trade-off: this slightly under-credits rewards at the boundary (the audit's stated
acceptable trade-off), but never traps funds.

The `vm.skip(true)` in `invariant_exitNeverRevertsFromRewardUnderflow` was removed so
the invariant is now a live guard; the deterministic repro and replay tests were
flipped from proving-the-bug to proving-the-fix.

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
| `foundry.toml` | Foundry profile for the security harness (Hardhat remains the canonical toolchain; compiler settings mirror Hardhat) |
| `test/foundry/mocks/MockRewardController.sol` | Minimal `IController` stub mirroring the reward distribution arithmetic |
| `test/foundry/RewardInvariant.handler.sol` | Stateful fuzz handler (add/remove/borrow/repay/claim/reinvest/warp) with precise underflow attribution |
| `test/foundry/RewardInvariant.t.sol` | Invariants: S1 (now LIVE + green post-fix), claim-side guard, reward conservation (P4), over-crediting bound (P4), deterministic replay |
| `test/foundry/RewardUnderflowRepro.t.sol` | Minimal deterministic repro — now asserts the LP CAN withdraw (proves the fix) |

Install the pinned forge-std revision and run the harness:

```bash
forge install --no-git foundry-rs/forge-std@rev=bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
yarn test:foundry
```

## Non-zero reward coefficient (audit finding T1)

The inherited core suite historically ran with `REWARD_COEFFICIENT='0'`, so the
reward *amounts* were always zero across the ~150 share-array edge-case tests.
`test/pool.spec.ts` now reads the coefficient from the `REWARD_COEFFICIENT` env var
(default `'0'`), and CI runs the suite twice (0 and `1e15`) so the bookkeeping
side-effects are exercised under live rewards across every scenario.
