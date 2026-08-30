# Providing Liquidity

This guide explains how to provide liquidity to VinuFinance pools and earn yield from borrower interest payments.

## Overview

Liquidity Providers (LPs) deposit loan currency tokens into pools and earn:

1. **Interest from loans** - Pro-rata share of repaid interest
2. **Collateral from defaults** - Pro-rata share of forfeited collateral when borrowers don't repay
3. **LP rewards** - Additional token rewards from whitelisted pools

## How LP Shares Work

When you deposit liquidity, you receive LP shares representing your ownership of the pool:

```
                    Your Deposit
LP Shares = ─────────────────────────────────
            Total Pool Liquidity / Total Shares
```

Your shares entitle you to:
- Proportional claims on loan repayments
- Proportional claims on defaulted collateral
- Voting weight for governance (if staked)

## Step-by-Step Guide

### 1. Choose a Pool

Each pool has specific parameters:

| Parameter | Description |
|-----------|-------------|
| Loan Currency | Token you'll deposit (e.g., USDT) |
| Collateral Currency | Token borrowers pledge (e.g., WVC) |
| Loan Tenor | Duration of loans |
| Interest Rates | Current rates based on utilization |
| Min Loan | Smallest loan allowed |

### 2. Approve Token Spending

Before depositing, approve the pool contract to spend your tokens:

```solidity
// Approve pool to spend your loan tokens
loanToken.approve(poolAddress, depositAmount);
```

### 3. Add Liquidity

The pool must be currently whitelisted by the Controller before a new deposit
can be accepted. A dewhitelist stops new deposits atomically; it does not lock
existing LP exits or settled claim-only withdrawals.

Call the `addLiquidity` function:

```solidity
function addLiquidity(
    address _onBehalfOf,    // Recipient of LP shares (your address)
    uint128 _sendAmount,    // Amount to deposit
    uint256 _deadline,      // Transaction deadline
    uint256 _referralCode   // Optional referral code (0 if none)
) external payable;
```

**Example:**
```javascript
// Deposit 1000 USDT
await pool.addLiquidity(
    myAddress,           // Receive LP shares to my address
    1000 * 10**6,       // 1000 USDT (6 decimals)
    Math.floor(Date.now() / 1000) + 3600,  // 1 hour deadline
    0                    // No referral
);
```

### 4. Track Your Position

After depositing, your position is tracked via LP shares:

```solidity
// Get your LP info
(
    uint32 fromLoanIdx,
    uint32 earliestRemove,
    uint32 currSharePtr,
    uint256[] memory shares,
    uint256[] memory loanIdxs
) = pool.getLpInfo(myAddress);
```

## Minimum Locking Period

**Important:** After depositing, you must wait at least **120 seconds** before removing liquidity. This prevents flash loan attacks.

```
┌─────────────────────────────────────────────────────────────────┐
│                    LP Timeline                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Deposit ──► 120s Lock ──► Can Remove ──► Claim Settled Loans   │
│                                                                  │
│  • Your shares start earning from new loans immediately         │
│  • You can only claim from loans made AFTER your deposit        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Claiming Returns

As loans are repaid or default, you can claim your share:

```solidity
// Claim from specific loan indices
pool.claim(
    myAddress,           // Claim to my address
    [5, 6, 7, 8, 9],    // Loan indices to claim from
    false,               // Don't reinvest (withdraw instead)
    deadline
);
```

See the [Claiming Guide](claiming.md) for detailed instructions.

## Removing Liquidity

To withdraw your deposited tokens:

```solidity
function removeLiquidity(
    address _onBehalfOf,  // Recipient of withdrawn tokens
    uint128 numShares     // Number of LP shares to burn
) external;
```

**Important considerations:**
- You can only remove liquidity not currently lent out
- Your shares may be partially locked in active loans
- Claim settled loans first to maximize available liquidity

## LP Rewards

If the pool is **whitelisted** by governance, you earn additional token rewards:

```
                    Your Liquidity × Duration × Reward Coefficient
Reward Amount = ───────────────────────────────────────────────────
                              Scaling Factor
```

Rewards are automatically distributed when:
- You add more liquidity
- You remove liquidity
- You claim from loans
- Someone calls `forceRewardUpdate` for you

## Risks

### Smart Contract Risk
Pool contracts may contain undiscovered vulnerabilities.

### Collateral Value Risk
If collateral value drops significantly below loan value when a borrower defaults, you may receive collateral worth less than the loan amount.

### Liquidity Lock Risk
Your liquidity may be locked in active loans until they expire or are repaid.

### Pool-Specific Risks
Each pool has different parameters affecting risk/reward profile.

## Delegated Operations

You can authorize others to manage your LP position:

```solidity
// Approve another address to add liquidity on your behalf
pool.setApprovals(
    trustedAddress,
    2  // ADD_LIQUIDITY approval flag
);
```

See [Approval Types](../reference/contracts/base-pool.md#approval-system) for all options.

## Best Practices

1. **Diversify** - Spread liquidity across multiple pools
2. **Monitor Utilization** - Higher utilization = higher rates but less liquidity available
3. **Regular Claims** - Claim settled loans regularly to compound returns
4. **Check Collateral** - Understand what collateral you may receive on defaults
5. **Use Referrals** - Help grow the protocol and potentially earn referral rewards

## Example: Complete LP Flow

```javascript
// 1. Approve tokens
const depositAmount = ethers.utils.parseUnits("1000", 6); // 1000 USDT
await usdt.approve(poolAddress, depositAmount);

// 2. Deposit liquidity
const deadline = Math.floor(Date.now() / 1000) + 3600;
await pool.addLiquidity(myAddress, depositAmount, deadline, 0);

// 3. Wait for loans to settle...

// 4. Check claimable loans
const lpInfo = await pool.getLpInfo(myAddress);
const loanIdx = await pool.getPoolInfo().loanIdx;

// 5. Claim returns
const claimableLoans = [lpInfo.fromLoanIdx, lpInfo.fromLoanIdx + 1, ...];
await pool.claim(myAddress, claimableLoans, false, deadline);

// 6. Remove liquidity when done
await pool.removeLiquidity(myAddress, sharesToRemove);
```

## Related

- [Claiming Guide](claiming.md)
- [BasePool Reference](../reference/contracts/base-pool.md)
- [Interest Rates](../overview/interest-rates.md)
