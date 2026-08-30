# MultiClaim

A helper contract for claiming bounded consecutive loan groups in a single transaction.

**Source:** `contracts/MultiClaim.sol`

## Overview

The BasePool's `claim()` function requires a consecutive settled prefix beginning at the LP's current claim cursor. MultiClaim batches that one global prefix into multiple calls efficiently; it does not support sparse gaps.

## Use Case

Consider an LP with settled loans 1-5 and 6-10:

**Without MultiClaim:**
```javascript
// Two separate transactions
await pool.claim(lp, [1, 2, 3, 4, 5], false, deadline);
await pool.claim(lp, [6, 7, 8, 9, 10], false, deadline);
```

**With MultiClaim:**
```javascript
// Single transaction
await multiClaim.claimMultiple(
    poolAddress,
    [[1, 2, 3], [4, 5, 6, 7, 8, 9, 10]],
    [false, false],
    deadline
);
```

## Functions

### claimMultiple

```solidity
function claimMultiple(
    IBasePool _pool,
    uint256[][] calldata _loanIdxs,
    bool[] calldata _isReinvested,
    uint256 _deadline
) external
```

Claims from multiple groups of loans in a single transaction.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_pool` | `IBasePool` | Pool to claim from |
| `_loanIdxs` | `uint256[][]` | Array of arrays of loan indices |
| `_isReinvested` | `bool[]` | Whether to reinvest each group |
| `_deadline` | `uint256` | Transaction deadline |

**Requirements:**
- `_loanIdxs.length > 0`
- `_loanIdxs.length == _isReinvested.length`
- Each sub-array must be non-empty
- Each sub-array must be non-empty and strictly consecutive
- The first index of each later group must immediately follow the previous group's last index

**Example:**

```javascript
const multiClaim = new ethers.Contract(multiClaimAddress, MultiClaimABI, signer);

// Claim one global prefix in two consecutive groups (reinvest first, withdraw second)
await multiClaim.claimMultiple(
    poolAddress,
    [
        [1, 2, 3],             // First group
        [4, 5, 6, 7, 8, 9, 10]  // Second group
    ],
    [true, false],           // Reinvest first, withdraw second
    Math.floor(Date.now() / 1000) + 3600
);
```

## How It Works

1. Fetches loan and collateral token addresses from pool
2. Records token balances before claiming
3. Iterates through each sub-array, calling `pool.claim()`
4. Calculates tokens received
5. Transfers any non-reinvested tokens to caller

```
┌─────────────────────────────────────────────────────────────────┐
│                     MultiClaim Contract                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Get pool info (tokens)                                      │
│     ┌─────────────┐                                             │
│     │   Pool      │ ──► loanCcyToken, collCcyToken             │
│     └─────────────┘                                             │
│                                                                 │
│  2. Record balances before                                      │
│     balanceBefore[loanCcy] = balance                            │
│     balanceBefore[collCcy] = balance                            │
│                                                                 │
│  3. Process each claim group                                    │
│     for each (loanIdxs, isReinvested):                          │
│         pool.claim(caller, loanIdxs, isReinvested, deadline)    │
│                                                                 │
│  4. Transfer received tokens to caller                          │
│     if loanCcy balance increased: transfer to caller            │
│     if collCcy balance increased: transfer to caller            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Setup Requirements

Before using MultiClaim, you must approve it to act on your behalf in the pool:

```javascript
// Approve MultiClaim for CLAIM permission (bit 3 = 8)
await pool.setApprovals(multiClaimAddress, 8);

// If reinvesting, also need ADD_LIQUIDITY (bit 1 = 2)
// CLAIM + ADD_LIQUIDITY = 8 + 2 = 10
await pool.setApprovals(multiClaimAddress, 10);
```

## Gas Considerations

MultiClaim saves gas when splitting one consecutive claim prefix into groups:

| Scenario | Without MultiClaim | With MultiClaim |
|----------|-------------------|-----------------|
| 2 groups | 2 transactions | 1 transaction |
| 3 groups | 3 transactions | 1 transaction |
| 5 groups | 5 transactions | 1 transaction |

Savings increase with:
- More claim groups
- Higher base gas cost per transaction
- Network congestion

## Error Messages

| Error | Meaning |
|-------|---------|
| `MultiClaim: Empty loan index array.` | `_loanIdxs` is empty |
| `MultiClaim: Inconsistent lengths.` | Arrays have different lengths |
| `MultiClaim: Empty loan index sub-array.` | A sub-array is empty |
| `MultiClaim: Non-consecutive loan indices.` | A group has a gap from the previous group |

## Related

- [BasePool Reference](base-pool.md)
- [Claiming Rewards Guide](../../guides/claiming.md)
