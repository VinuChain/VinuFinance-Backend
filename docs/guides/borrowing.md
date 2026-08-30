# Borrowing

This guide explains how to borrow from VinuFinance pools using the Zero Liquidation Loan mechanism.

## Overview

VinuFinance offers **Zero Liquidation Loans** - a revolutionary approach to DeFi lending:

- **No Liquidations** - Your position is never forcibly liquidated
- **Fixed Terms** - Know exactly what you'll repay upfront
- **Your Choice** - Repay to reclaim collateral, or don't and forfeit it

```
┌─────────────────────────────────────────────────────────────────┐
│                 Zero Liquidation Loan Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Pledge Collateral ──► Receive Loan ──► Choose Your Path:       │
│                                                                  │
│       Path A: Repay before expiry → Get collateral back         │
│       Path B: Don't repay → Forfeit collateral to LPs           │
│                                                                  │
│  Either way: NO LIQUIDATION, NO MARGIN CALLS                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## How Loans Work

### Loan Parameters

Each pool determines:

| Parameter | Description |
|-----------|-------------|
| `maxLoanPerColl` | Maximum loan per unit of collateral |
| `loanTenor` | Loan duration (e.g., 30 days) |
| `minLoan` | Minimum loan amount |
| Interest Rate | Dynamic rate based on pool utilization |

### Loan Calculation

```
                         Collateral Amount
Loan Amount = ──────────────────────────────────────────
              Collateral Required Per Loan Unit
```

The repayment amount includes interest calculated at the time of borrowing.

## Step-by-Step Guide

### 1. Check Loan Terms

Before borrowing, query the terms you'll receive:

```solidity
(
    uint128 loanAmount,       // What you'll receive
    uint128 repaymentAmount,  // What you'll owe
    uint128 pledgeAmount,     // Collateral needed
    uint256 creatorFee,       // Protocol fee (legacy ABI name)
    uint256 totalLiquidity    // Available liquidity
) = pool.loanTerms(collateralAmount);
```

**Example in JavaScript:**
```javascript
// Check terms for 100 WVC collateral
const collateral = ethers.utils.parseEther("100");
const terms = await pool.loanTerms(collateral);

console.log("You'll receive:", terms.loanAmount);
console.log("You'll owe:", terms.repaymentAmount);
console.log("Interest:", terms.repaymentAmount - terms.loanAmount);
```

### 2. Approve Collateral

Approve the pool to take your collateral:

```solidity
collateralToken.approve(poolAddress, pledgeAmount);
```

### 3. Execute Borrow

Call the `borrow` function:

```solidity
function borrow(
    address _onBehalfOf,    // Loan recipient
    uint128 _sendAmount,    // Collateral amount to pledge
    uint128 _minLoanLimit,  // Minimum acceptable loan
    uint128 _maxRepayLimit, // Maximum acceptable repayment
    uint256 _deadline,      // Transaction deadline
    uint256 _referralCode   // Optional referral code
) external payable;
```

**Parameters explained:**

- `_minLoanLimit`: Protects against receiving less than expected (slippage protection)
- `_maxRepayLimit`: Protects against paying more interest than expected

**Example:**
```javascript
// Borrow against 100 WVC collateral
const collateral = ethers.utils.parseEther("100");
const deadline = Math.floor(Date.now() / 1000) + 3600;

await pool.borrow(
    myAddress,      // Receive loan to my address
    collateral,     // Pledge 100 WVC
    minLoan,        // At least this much loan
    maxRepay,       // At most this repayment
    deadline,       // 1 hour deadline
    0               // No referral
);
```

### 4. Track Your Loan

After borrowing, find your loan index from the emitted event:

```solidity
event Borrow(
    address indexed borrower,
    uint256 loanIdx,           // Your loan index
    uint256 collateral,
    uint256 loanAmount,
    uint256 repaymentAmount,
    uint256 totalLpShares,
    uint256 indexed expiry,
    uint256 indexed referralCode
);
```

Query loan details:
```javascript
const loanInfo = await pool.loanIdxToLoanInfo(loanIdx);
// Returns: repayment, collateral, loanAmount, totalLpShares, expiry, repaid
```

## Repaying Your Loan

### Before Expiry

To reclaim your collateral, repay before the loan expires:

```solidity
function repay(
    uint256 _loanIdx,    // Your loan index
    address _recipient   // Where to send collateral
) external payable;
```

**Steps:**
1. Approve repayment amount (loan token)
2. Call repay with your loan index

```javascript
// Approve repayment
await loanToken.approve(poolAddress, repaymentAmount);

// Repay and get collateral back
await pool.repay(loanIdx, myAddress);
```

### Partial Repayment

**Note:** Partial repayment is not supported. You must repay the full amount to reclaim your collateral.

### After Expiry

If you don't repay before expiry:
- Your collateral is forfeited to LPs
- You keep the loan tokens
- **No further action required from you**

```
┌────────────────────────────────────────────────────────────┐
│                      Loan Timeline                          │
├────────────────────────────────────────────────────────────┤
│                                                             │
│  Borrow ──────────────────────────────► Expiry             │
│    │                                       │                │
│    │    ◄── Can repay anytime ──►         │                │
│    │                                       │                │
│    │                                       ▼                │
│    │                              Collateral forfeited      │
│    │                              (LPs can claim it)        │
│    │                                                        │
│    ▼                                                        │
│  Repaid: Get collateral back                               │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

## Delegated Repayment

Others can repay on your behalf if you've approved them:

```solidity
// Approve another address to repay for you
pool.setApprovals(trustedAddress, 1); // REPAY = 0, so flag is 1

// Now trustedAddress can call:
pool.repay(yourLoanIdx, yourAddress);
```

## Interest Rate Dynamics

The borrow rate is driven by the pool's **available liquidity**
(`totalLiquidity − minLiquidity`), not a utilization percentage. As available
liquidity falls, the rate rises:

| Available liquidity | Rate behavior |
|---------------------|---------------|
| Above `liquidityBnd2` | Flat at the minimum rate `r2` |
| Between `liquidityBnd1` and `liquidityBnd2` | Linear, rising from `r2` toward `r1` as liquidity drops |
| Below `liquidityBnd1` | Hyperbolic, above `r1` (`r1 × liquidityBnd1 / liquidity`) |

The repayment uses the **average** rate across pre- and post-borrow liquidity.
See [Interest Rates](../overview/interest-rates.md) for the exact formula.

**Check current rates before borrowing:**
```javascript
const terms = await pool.loanTerms(collateralAmount);
const interestRate = (terms.repaymentAmount - terms.loanAmount) / terms.loanAmount;
console.log("Interest rate:", (interestRate * 100).toFixed(2) + "%");
```

## Use Cases

### Put Option Equivalent

Zero liquidation loans function like **put options** on your collateral:

- Pledge volatile asset (e.g., WVC)
- Get stablecoin loan (e.g., USDT)
- If collateral drops: Keep the loan, forfeit worthless collateral
- If collateral rises: Repay and profit

### Leverage Without Liquidation

- Borrow against holdings
- Use loan to buy more collateral
- No liquidation risk during volatility
- Repay when conditions are favorable

### Cash Extraction

- Need liquidity without selling assets
- Borrow against long-term holdings
- Repay later to retain position

## Fees

| Fee Type | Description |
|----------|-------------|
| Interest | Included in repayment amount |
| Protocol Fee (`creatorFee` in the legacy ABI) | Deducted from collateral and deposited in the Controller for vote-token snapshot distribution |

All fees are known upfront before you borrow.

## Paused Pools

If a pool is paused by governance:
- **Borrowing is disabled**
- Existing loans can still be repaid
- LPs can still claim and remove liquidity

Check pool status before attempting to borrow.

## Best Practices

1. **Check Terms First** - Always call `loanTerms()` before borrowing
2. **Set Slippage Protection** - Use appropriate `_minLoan` and `_maxRepay`
3. **Monitor Expiry** - Set reminders for loan expiration
4. **Calculate Break-Even** - Know at what collateral price repaying makes sense
5. **Consider Gas** - Factor in gas costs for repayment transaction

## Example: Complete Borrow Flow

```javascript
// 1. Check available terms
const collateral = ethers.utils.parseEther("100");
const terms = await pool.loanTerms(collateral);

console.log("Loan amount:", ethers.utils.formatUnits(terms.loanAmount, 6));
console.log("Repayment:", ethers.utils.formatUnits(terms.repaymentAmount, 6));

// 2. Set slippage protection (2% tolerance)
const minLoan = terms.loanAmount.mul(98).div(100);
const maxRepay = terms.repaymentAmount.mul(102).div(100);

// 3. Approve collateral
await collToken.approve(poolAddress, collateral);

// 4. Borrow
const deadline = Math.floor(Date.now() / 1000) + 3600;
const tx = await pool.borrow(
    myAddress,
    collateral,
    minLoan,
    maxRepay,
    deadline,
    0
);

// 5. Get loan index from event
const receipt = await tx.wait();
const borrowEvent = receipt.events.find(e => e.event === "Borrow");
const loanIdx = borrowEvent.args.loanIdx;

console.log("Loan created:", loanIdx.toString());

// Later: Repay to get collateral back
await loanToken.approve(poolAddress, terms.repaymentAmount);
await pool.repay(loanIdx, myAddress);
```

## Related

- [Interest Rates](../overview/interest-rates.md)
- [Providing Liquidity](providing-liquidity.md)
- [BasePool Reference](../reference/contracts/base-pool.md)
