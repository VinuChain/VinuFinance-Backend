# Core Concepts

This page explains the fundamental concepts behind VinuFinance's Zero Liquidation Lending protocol.

## Zero Liquidation Loans

Unlike traditional DeFi lending protocols (Aave, Compound), VinuFinance implements **Zero Liquidation Loans**:

| Traditional Lending | VinuFinance |
|---------------------|-------------|
| Variable loan terms | Fixed loan tenor |
| Can be liquidated if collateral falls | Never liquidated |
| Must monitor health factor | Set and forget |
| Partial liquidations possible | Binary outcome: repay or forfeit |

### How It Works

1. **Borrower pledges collateral** (e.g., WVC)
2. **Receives loan** in loan currency (e.g., USDT)
3. **At expiry**, borrower either:
   - **Repays** loan + interest → gets collateral back
   - **Defaults** → forfeits collateral to LPs

```
Timeline:
├─────────────────────────────────────────────────────────────────┤
│  Borrow                                           Expiry        │
│    │                                                │           │
│    ▼                                                ▼           │
│  Pledge collateral                    Option A: Repay loan      │
│  Receive loan                         → Reclaim collateral      │
│                                                                 │
│                                       Option B: Don't repay     │
│                                       → Collateral to LPs       │
└─────────────────────────────────────────────────────────────────┘
```

## Liquidity Providers (LPs)

LPs deposit loan currency into pools and earn yield through:

1. **Interest from repaid loans** - Borrowers pay interest on repayment
2. **Collateral from defaults** - If borrowers don't repay, LPs receive the collateral
3. **LP Rewards** - Additional token rewards from the protocol

### LP Shares

When LPs deposit, they receive **LP shares** representing their portion of the pool:

```
// Standard formula (when pool has existing shares)
LP Shares = (Deposit Amount × Total LP Shares) / Total Liquidity

// First LP deposit (when totalLpShares == 0)
LP Shares = (Deposit Amount × 1000) / minLiquidity
```

Shares entitle holders to:
- Pro-rata share of loan repayments
- Pro-rata share of forfeited collateral
- Protocol rewards based on liquidity provided

### Claiming

LPs must **claim** their share of settled loans:
- **Repaid loans**: Claim loan currency (principal + interest)
- **Defaulted loans**: Claim collateral

Claims can be:
- Withdrawn to wallet
- **Reinvested** back into the pool

## Borrowers

Borrowers can obtain loans by pledging collateral:

### Loan Terms

| Parameter | Description |
|-----------|-------------|
| **Loan Amount** | Amount of loan currency received |
| **Repayment Amount** | Amount required to reclaim collateral |
| **Collateral** | Assets pledged (minus the protocol fee) |
| **Expiry** | Timestamp by which repayment is due |
| **Interest** | `Repayment - Loan Amount` |

### Loan Calculation

The loan amount is determined by:

```
Loan = (Pledge × MaxLoanPerColl × AvailableLiquidity) /
       (Pledge × MaxLoanPerColl + AvailableLiquidity × 10^CollDecimals)
```

This formula ensures:
- Larger pledges get proportionally more loan
- Pool utilization affects loan size
- No single loan can drain the pool

## Interest Rates

VinuFinance uses a **dynamic interest rate model** with three regions:

### Rate Regions

```
Interest
Rate (r)
    │
r1  ├─────┐
    │      \
    │       \  Target Range
    │        \
r2  ├─────────────────────────────
    │
    └──────────────────────────────► Liquidity
         L1       L2
```

| Region | Liquidity | Rate Behavior |
|--------|-----------|---------------|
| **Low** | < L1 | Hyperbolic: `r = r1 × L1 / liquidity` |
| **Target** | L1 to L2 | Linear interpolation between r1 and r2 |
| **High** | > L2 | Constant at r2 (minimum rate) |

This encourages:
- **High rates** when liquidity is scarce (attracts LPs)
- **Low rates** when liquidity is abundant (attracts borrowers)

## Protocol Fee

Each pool has a protocol fee (named `creatorFee` in the legacy ABI, max 3%)
deducted from collateral:

```
Pledge Amount = Collateral Sent - Protocol Fee
Protocol Fee = Collateral Sent × Fee Rate / BASE
```

The fee is deposited in the Controller as protocol revenue and distributed
through vote-token snapshots. It is not paid to the pool creator or a treasury.

## LP Rewards

Beyond interest and collateral claims, LPs earn **token rewards**:

```
Reward = Liquidity × Duration × Reward Coefficient / BASE
```

Rewards:
- Accumulate over time based on LP position
- Are distributed in the protocol's vote token
- Can be collected and optionally auto-staked

## Approvals System

VinuFinance supports **delegated operations** via approvals:

| Approval Type | Permission |
|---------------|------------|
| `REPAY` | Repay loans on behalf of borrower |
| `ADD_LIQUIDITY` | Add liquidity on behalf of LP |
| `REMOVE_LIQUIDITY` | Remove liquidity on behalf of LP |
| `CLAIM` | Claim rewards on behalf of LP |
| `FORCE_REWARD_UPDATE` | Update reward state |

Approvals are set via packed bitmasks for gas efficiency.

## Related

- [Architecture](architecture.md)
- [Interest Rates](interest-rates.md)
- [Providing Liquidity Guide](../guides/providing-liquidity.md)
