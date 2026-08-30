# Creating Pools

This guide explains how to create and configure new lending pools in VinuFinance.

## Overview

Each BasePool is a standalone lending market with specific:
- Token pair (loan currency + collateral currency)
- Interest rate parameters
- Loan terms (duration, LTV ratio)
- Fee structure

## Pool Parameters

### Token Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `_tokens` | IERC20[] | Array of [loanCcyToken, collCcyToken] |
| `_collTokenDecimals` | uint256 | Decimals of the collateral token |

**Considerations:**
- Tokens passed as array: `[loanToken, collToken]`
- Loan token should have stable value (stablecoins preferred)
- Collateral token should have liquid markets for LPs to sell defaults
- Specify collateral token decimals explicitly

### Loan Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `loanTenor` | uint256 | Loan duration in seconds |
| `maxLoanPerColl` | uint256 | Maximum loan per unit of collateral |
| `minLoan` | uint256 | Minimum loan amount |

#### Loan Tenor

Common durations:

| Duration | Seconds |
|----------|---------|
| 1 day | 86,400 |
| 7 days | 604,800 |
| 14 days | 1,209,600 |
| 30 days | 2,592,000 |
| 90 days | 7,776,000 |

**Minimum:** 86,400 seconds (1 day) - enforced by `MIN_TENOR`

#### Max Loan Per Collateral

This determines the effective LTV ratio:

```
                    Loan Amount Received
Effective LTV = ──────────────────────────────
                Collateral Value (at current price)
```

**Example:**
- If WVC price = $2.00
- maxLoanPerColl = 0.5 (in loan token units per collateral unit)
- For 100 WVC pledged: max loan = 100 × 0.5 = 50 USDT
- Effective LTV = 50 / (100 × 2) = 25%

**Setting maxLoanPerColl:**
```javascript
// For 50% LTV at current prices
const collateralPrice = 2.0;    // $2 per WVC
const desiredLTV = 0.5;         // 50%
const maxLoanPerColl = collateralPrice * desiredLTV; // 1.0
```

### Interest Rate Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `r1` | uint256 | Rate at low available liquidity (start of target range) — the **higher** rate; must be > r2 |
| `r2` | uint256 | Minimum rate at high available liquidity (end of target range); must be > 0 |
| `liquidityBnd1` | uint256 | First boundary (start of linear region) |
| `liquidityBnd2` | uint256 | Second boundary (end of linear region) |

#### Interest Rate Model

```
rate
 ▲
 │\                       liquidity < bnd1 : hyperbolic, r = r1 × bnd1 / liquidity  (≥ r1)
 │ \
r1┤  \____                bnd1 ≤ liquidity ≤ bnd2 : linear, r1 down to r2
 │      \____
r2┤          \__________  liquidity > bnd2 : flat at r2 (minimum rate)
 │
 └────┬─────┬───────────► available liquidity (totalLiquidity − minLiquidity)
     bnd1  bnd2
```
Lower available liquidity ⇒ higher rate. r1 (the higher rate) applies at the
scarce-liquidity end; r2 (the minimum) applies when liquidity is abundant.

#### Example Configuration

For a pool with moderate risk tolerance:

```javascript
const BASE = ethers.utils.parseUnits("1", 18);

// Interest rates — per loan tenor (NOT annualized), denominated in BASE
const r1 = BASE.mul(15).div(100);  // 15% — rate at low available liquidity (must exceed r2)
const r2 = BASE.mul(2).div(100);   // 2%  — minimum rate at abundant liquidity

// Liquidity boundaries (in loan token units)
const liquidityBnd1 = ethers.utils.parseUnits("10000", 6);  // 10k USDT
const liquidityBnd2 = ethers.utils.parseUnits("100000", 6); // 100k USDT
```

**Rate behavior** (available liquidity = totalLiquidity − minLiquidity):
- Below 10k: rate rises hyperbolically above r1 as liquidity falls (`r1 × bnd1 / liquidity`)
- 10k–100k: rate interpolates linearly between r1 (at 10k) and r2 (at 100k)
- Above 100k: rate stays constant at the minimum, r2

The constructor rejects a rate domain whose low-liquidity peak could make the
minimum valid loan's repayment exceed the `uint128` loan accounting field.
With `U = 2^128 - 1`, the exact peak-rate ceiling is
`floor(((U - minLoan + 1) × BASE - 1) / minLoan)`; configure `r1 × bnd1`
at or below that ceiling.

### Fee Parameters

| Parameter | Type | Description | Max |
|-----------|------|-------------|-----|
| `creatorFee` | uint256 | Protocol fee (legacy ABI/config name) | 3% (MAX_FEE) |

`creatorFee` is taken from each loan’s collateral as a percentage and deposited
as Controller protocol revenue for vote-token snapshot distribution. Despite
the legacy name, it is not paid to the pool creator or a treasury; use
“protocol fee” in user-facing copy.

### Liquidity Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `minLiquidity` | uint256 | Minimum liquidity (at least 1000) |

The minimum liquidity ensures LP shares can be minted based on 1/1000th discretization.

**Example:**
```javascript
// 1% protocol fee (legacy creatorFee identifier)
const creatorFee = BASE.mul(1).div(100);
```

### Governance Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `poolController` | address | Controller contract address |
| `rewardCoefficient` | uint96 | Multiplier for LP rewards |

#### Reward Coefficient

Higher coefficients = more LP rewards (if pool is whitelisted):

```javascript
// Standard reward coefficient
const rewardCoefficient = BASE;  // 1x rewards

// Premium pool with 2x rewards
const rewardCoefficient = BASE.mul(2);  // 2x rewards
```

## Complete Example

### Pool Configuration

```javascript
const config = {
    // Tokens (passed as array)
    tokens: ["0x...", "0x..."],  // [USDT, WVC]
    collTokenDecimals: 18,       // WVC decimals

    // Loan terms
    loanTenor: 2592000,          // 30 days
    maxLoanPerColl: ethers.utils.parseUnits("0.5", 18),  // 0.5 USDT per WVC
    minLoan: ethers.utils.parseUnits("100", 6),  // 100 USDT min

    // Interest rates (passed as array)
    rs: [
        ethers.utils.parseUnits("0.15", 18),  // r1 = 15% (rate at low liquidity; must exceed r2)
        ethers.utils.parseUnits("0.02", 18)   // r2 = 2%  (minimum rate)
    ],
    liquidityBnds: [
        ethers.utils.parseUnits("10000", 6),   // 10k USDT bnd1
        ethers.utils.parseUnits("100000", 6)   // 100k USDT bnd2
    ],

    // Fees and liquidity
    creatorFee: ethers.utils.parseUnits("0.01", 18),  // 1% protocol fee
    minLiquidity: ethers.utils.parseUnits("1000", 6), // 1000 USDT min

    // Governance
    controller: "0x...",
    rewardCoefficient: ethers.utils.parseUnits("1", 18)  // 1x
};
```

### Deployment Script

```javascript
async function deployPool(config) {
    const BasePool = await ethers.getContractFactory("BasePool");

    const pool = await BasePool.deploy(
        config.tokens,            // _tokens array
        config.collTokenDecimals, // _collTokenDecimals
        config.loanTenor,         // _loanTenor
        config.maxLoanPerColl,    // _maxLoanPerColl
        config.rs,                // _rs array
        config.liquidityBnds,     // _liquidityBnds array
        config.minLoan,           // _minLoan
        config.creatorFee,        // _creatorFee
        config.minLiquidity,      // _minLiquidity
        config.controller,        // _poolController
        config.rewardCoefficient  // _rewardCoefficient
    );

    await pool.deployed();

    console.log("Pool deployed:", pool.address);
    return pool;
}
```

## Pool Templates

### Conservative Stablecoin Pool

Low risk, lower returns:

```javascript
{
    loanTenor: 2592000,          // 30 days
    maxLoanPerColl: 0.3,         // 30% effective LTV
    r1: 0.08,                    // 8% (rate at low liquidity; must exceed r2)
    r2: 0.01,                    // 1% (minimum rate)
    liquidityBnd1: 100000,       // 100k
    liquidityBnd2: 500000,       // 500k
    minLoan: 1000,               // 1000 USDT
    creatorFee: 0.005            // 0.5% protocol fee
}
```

### Standard Pool

Balanced risk/reward:

```javascript
{
    loanTenor: 2592000,          // 30 days
    maxLoanPerColl: 0.5,         // 50% effective LTV
    r1: 0.15,                    // 15% (rate at low liquidity; must exceed r2)
    r2: 0.02,                    // 2% (minimum rate)
    liquidityBnd1: 10000,        // 10k
    liquidityBnd2: 100000,       // 100k
    minLoan: 100,                // 100 USDT
    creatorFee: 0.01             // 1% protocol fee
}
```

### Aggressive Short-Term Pool

Higher risk, higher returns:

```javascript
{
    loanTenor: 604800,           // 7 days
    maxLoanPerColl: 0.7,         // 70% effective LTV
    r1: 0.30,                    // 30% (rate at low liquidity; must exceed r2)
    r2: 0.05,                    // 5% (minimum rate)
    liquidityBnd1: 5000,         // 5k
    liquidityBnd2: 25000,        // 25k
    minLoan: 50,                 // 50 USDT
    creatorFee: 0.02             // 2% protocol fee
}
```

## Parameter Validation

### Automatic Checks

The contract validates:

```solidity
require(_loanTenor >= MIN_TENOR, "Loam tenor must be at least MIN_TENOR.");
// rate params: r1 must be strictly greater than r2, and r2 must be non-zero
if (_rs[0] <= _rs[1] || _rs[1] == 0) revert("Invalid rate parameters.");
if (_liquidityBnds[1] <= _liquidityBnds[0] || _liquidityBnds[0] == 0) revert("Invalid liquidity bounds");
// peak low-liquidity rate must keep the minimum repayment within uint128
uint256 maxRate = ((type(uint128).max - _minLoan + 1) * BASE - 1) / _minLoan;
require(_rs[0] <= maxRate / _liquidityBnds[0], "Rate parameters too large.");
require(_minLiquidity >= 1000, "Min liquidity must be at least 1000.");
require(_creatorFee <= MAX_FEE, "Creator fee too high.");
```

### Manual Verification

Before deploying, verify:

1. **Token decimals**: Ensure amounts match token decimals
2. **Rate reasonableness**: Compare to market rates
3. **LTV safety**: Consider collateral volatility
4. **Minimum viable liquidity**: liquidityBnd1 should be achievable
5. **Fee competitiveness**: Compare to other DeFi protocols

## Post-Deployment

### Seed Liquidity

Add initial liquidity to bootstrap the pool:

```javascript
// Approve and add liquidity
await loanToken.approve(pool.address, seedAmount);
await pool.addLiquidity(
    myAddress,
    seedAmount,
    deadline,
    0  // No referral
);
```

### Whitelist for Rewards

Create governance proposal to whitelist:

```javascript
await controller.createProposal(
    pool.address,
    2,  // WHITELIST action
    deadline
);
```

### Monitor Initial Activity

Watch for:
- First loans
- Interest rate behavior
- Liquidity changes
- Any unexpected behavior

## Multiple Pools

You can deploy multiple pools with different configurations:

```javascript
// Deploy USDT/WVC 30-day pool
const pool30d = await deployPool({
    ...baseConfig,
    loanTenor: 2592000
});

// Deploy USDT/WVC 7-day pool (override rates — the helper reads config.rs)
const pool7d = await deployPool({
    ...baseConfig,
    loanTenor: 604800,
    rs: [
        ethers.utils.parseUnits("0.20", 18),  // r1 (must exceed r2)
        ethers.utils.parseUnits("0.03", 18)   // r2
    ]
});

// Deploy USDT/WBTC pool (override the collateral token and its decimals)
const poolBTC = await deployPool({
    ...baseConfig,
    tokens: [usdtAddress, wbtcAddress],   // [loanCcyToken, collCcyToken]
    collTokenDecimals: 8,                 // WBTC has 8 decimals
    maxLoanPerColl: ethers.utils.parseUnits("30000", 18)  // higher loan per BTC unit
});
```

## Related

- [Deployment Overview](overview.md)
- [VinuChain Deployment](vinuchain.md)
- [Interest Rates](../overview/interest-rates.md)
- [BasePool Reference](../reference/contracts/base-pool.md)
