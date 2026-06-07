# Claiming

This guide explains how liquidity providers claim their share of loan repayments and defaulted collateral.

## Overview

As an LP, you're entitled to your pro-rata share of:

1. **Loan Repayments** - Principal + interest from repaid loans
2. **Defaulted Collateral** - Collateral from loans that weren't repaid

Claims are made on a per-loan basis using loan indices.

## How Claims Work

```
┌──────────────────────────────────────────────────────────────────┐
│                       Claim Calculation                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  For each settled loan you participated in:                      │
│                                                                   │
│                    Your LP Shares at Loan Time                    │
│  Your Share = ────────────────────────────────────                │
│                    Total LP Shares at Loan Time                   │
│                                                                   │
│  If Repaid:   You receive (Your Share × Repayment Amount)        │
│  If Default:  You receive (Your Share × Collateral Amount)       │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## Eligibility

You can only claim from loans that:

1. **Started after your deposit** - Your `fromLoanIdx` determines the first eligible loan
2. **Have settled** - Either repaid or expired (defaulted)
3. **You haven't already claimed from**

## Step-by-Step Guide

### 1. Check Your Position

Get your LP info to understand claimable loans:

```solidity
(
    uint32 fromLoanIdx,        // First loan you can claim from
    uint32 earliestRemove,     // When you can remove liquidity
    uint32 currSharePtr,       // Current position in history
    uint256[] memory shares,   // Your share history
    uint256[] memory loanIdxs  // When shares changed
) = pool.getLpInfo(myAddress);
```

### 2. Find Settled Loans

Check which loans have settled:

```javascript
// Get current loan index
const poolInfo = await pool.getPoolInfo();
const currentLoanIdx = poolInfo.loanIdx;

// Check each loan's status
for (let i = lpInfo.fromLoanIdx; i < currentLoanIdx; i++) {
    const loan = await pool.loanIdxToLoanInfo(i);
    const now = Math.floor(Date.now() / 1000);

    if (loan.repaid || now > loan.expiry) {
        console.log(`Loan ${i} is settled - claimable!`);
    }
}
```

### 3. Execute Claim

Call the `claim` function:

```solidity
function claim(
    address _onBehalfOf,         // Recipient of claimed tokens
    uint256[] calldata _loanIdxs, // Array of loan indices
    bool _isReinvested,          // Reinvest repayments?
    uint256 _deadline            // Transaction deadline
) external;
```

**Example:**
```javascript
const loansToClaim = [5, 6, 7, 8, 9, 10];
const deadline = Math.floor(Date.now() / 1000) + 3600;

await pool.claim(
    myAddress,          // Receive to my address
    loansToClaim,       // Claim from these loans
    false,              // Withdraw (don't reinvest)
    deadline
);
```

## Claim Options

### Withdraw Claims

Set `_isReinvested = false` to receive tokens directly:

- Repayments (loan tokens) sent to recipient
- Collateral (collateral tokens) sent to recipient

### Reinvest Claims

Set `_isReinvested = true` to automatically reinvest repayments:

- Repayments are added back to your LP position
- You receive additional LP shares
- Collateral is still sent to you (can't be reinvested)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Reinvest Flow                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Claim with reinvest=true:                                       │
│                                                                  │
│  Repayments ──► Automatically added to pool ──► More LP shares  │
│  Collateral ──► Sent to your wallet                             │
│                                                                  │
│  Benefits:                                                       │
│  • Compound your returns                                         │
│  • Single transaction                                            │
│  • Saves gas vs claim + addLiquidity                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Batch Claiming with MultiClaim

`BasePool.claim` requires every loan index in a single call to fall within one
**constant-share interval** — if your LP share balance changed partway through
(e.g. you added or removed liquidity), a call spanning that change reverts with
`"Loan indexes with changing shares."`. MultiClaim batches one `claim` per segment
in a single transaction:

```solidity
function claimMultiple(
    IBasePool _pool,
    uint256[][] calldata _loanIdxs,   // one ascending sub-array per constant-share segment
    bool[] calldata _isReinvested,    // reinvest flag per segment
    uint256 _deadline
) external;
```

```javascript
// e.g. your shares changed after loan 5: claim 1–5, then 6–12, in one tx
await multiClaim.claimMultiple(
    poolAddress,
    [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10, 11, 12]],
    [true, false],
    Math.floor(Date.now() / 1000) + 3600
);
```

> **Cursor warning — don't skip loans you're entitled to.** Each `claim` advances your
> `fromLoanIdx` cursor to the highest submitted index + 1. If you leave a gap over loans
> you still hold shares in (e.g. they haven't settled yet), the cursor moves past them and
> they become **permanently unclaimable** (a later claim reverts `"Unentitled from loan
> indices."`). Gaps are only safe across spans where you held **no** shares — the pool
> skips those automatically.

First approve MultiClaim on the pool for CLAIM (and ADD_LIQUIDITY if reinvesting):
`pool.setApprovals(multiClaimAddress, 10)` (CLAIM=8 + ADD_LIQUIDITY=2).

See [MultiClaim Reference](../reference/contracts/multi-claim.md) for details.

## What You Receive

### From Repaid Loans

```
Your Repayment = (Your Shares / Total Shares at Loan) × Loan Repayment
```

The repayment includes principal + interest, minus protocol fees.

### From Defaulted Loans

```
Your Collateral = (Your Shares / Total Shares at Loan) × Loan Collateral
```

You receive the collateral token instead of the loan token.

## Claim Events

Track claims via emitted events:

```solidity
event Claim(
    address indexed lp,
    uint256[] loanIdxs,      // Loans claimed from
    uint256 repayments,      // Total repayments received
    uint256 collateral       // Total collateral received
);
```

## Delegated Claiming

Authorize others to claim on your behalf:

```solidity
// Approve another address to claim for you
pool.setApprovals(trustedAddress, 8); // CLAIM flag

// Now they can call:
pool.claim(yourAddress, loanIdxs, reinvest, deadline);
```

## Share History

Your claim amounts depend on your share history:

```
┌──────────────────────────────────────────────────────────────────┐
│                    Share History Tracking                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Loan 1  Loan 2  Loan 3  Loan 4  Loan 5  Loan 6  Loan 7         │
│    │       │       │       │       │       │       │             │
│    ▼       ▼       ▼       ▼       ▼       ▼       ▼             │
│  ────────────────────────────────────────────────────────        │
│  │ 100 │ 100 │ 150 │ 150 │ 150 │ 50  │ 50  │  Your Shares      │
│  ────────────────────────────────────────────────────────        │
│           │               │                                       │
│           ▲               ▲                                       │
│      Added 50        Removed 100                                 │
│      liquidity       liquidity                                    │
│                                                                   │
│  Your claim from each loan uses your shares AT THAT LOAN TIME    │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## LP Rewards

When claiming (or any LP action), you may also receive LP rewards if:

1. Pool is whitelisted for rewards
2. You've held liquidity for some duration

Rewards are calculated as:

```
Reward = Liquidity × Duration × RewardCoefficient / ScalingFactor
```

## Best Practices

### Claim Regularly

- Don't let claimable loans accumulate excessively
- Regular claims help track your returns
- Reinvest to compound gains

### Batch Claims

- Claim multiple loans at once to save gas
- Use MultiClaim for multiple pools
- Optimal batch size: 10-50 loans

### Monitor Defaults

- Track which loans defaulted
- Understand the collateral you'll receive
- Consider selling collateral based on market conditions

### Update Share Pointer

Your `currSharePtr` tracks claim progress. If it gets stale:
- Claims become gas-inefficient
- Call `forceRewardUpdate` or make any LP action to update

## Example: Complete Claim Flow

```javascript
// 1. Get LP info
const lpInfo = await pool.getLpInfo(myAddress);
const fromLoanIdx = lpInfo.fromLoanIdx;

// 2. Get pool info for current loan index
const poolInfo = await pool.getPoolInfo();
const currentLoanIdx = poolInfo.loanIdx;

// 3. Find all claimable (settled) loans
const claimableLoans = [];
const now = Math.floor(Date.now() / 1000);

for (let i = fromLoanIdx; i < currentLoanIdx; i++) {
    const loan = await pool.loanIdxToLoanInfo(i);
    if (loan.repaid || now > loan.expiry) {
        claimableLoans.push(i);
    }
}

console.log(`Found ${claimableLoans.length} claimable loans`);

// 4. Claim in batches
const batchSize = 20;
for (let i = 0; i < claimableLoans.length; i += batchSize) {
    const batch = claimableLoans.slice(i, i + batchSize);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const tx = await pool.claim(
        myAddress,
        batch,
        true,  // Reinvest
        deadline
    );

    const receipt = await tx.wait();
    const claimEvent = receipt.events.find(e => e.event === "Claim");

    console.log(`Claimed batch ${i/batchSize + 1}:`);
    console.log(`  Repayments: ${claimEvent.args.repayments}`);
    console.log(`  Collateral: ${claimEvent.args.collateral}`);
}
```

## Troubleshooting

### "Loan not settled"

The loan hasn't expired and wasn't repaid yet. Wait for expiry.

### "Nothing to claim"

- You may have already claimed from these loans
- Check your `fromLoanIdx` - you can only claim from loans after that

### "Invalid loan index"

The loan index is either:
- Before your `fromLoanIdx`
- Greater than the current loan count
- Already claimed

### Gas too high

Reduce batch size or use MultiClaim for multiple pools.

## Related

- [Providing Liquidity](providing-liquidity.md)
- [MultiClaim Reference](../reference/contracts/multi-claim.md)
- [BasePool Reference](../reference/contracts/base-pool.md)
