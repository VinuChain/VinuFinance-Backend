# Introduction

VinuFinance is a decentralized lending protocol on VinuChain that enables **Zero Liquidation Loans** - a revolutionary approach to DeFi lending where borrowers are never liquidated.

## What is VinuFinance?

VinuFinance is a peer-to-pool lending protocol that allows:

* **Liquidity Providers (LPs)** to deposit assets and earn yield from loan interest
* **Borrowers** to obtain fixed-term loans by pledging collateral
* **Governance participants** to stake tokens and earn protocol revenue

### Key Features

| Feature              | Description                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| **Zero Liquidation** | Borrowers are never liquidated - they can repay to reclaim collateral or forfeit it |
| **Fixed Terms**      | All loans have predetermined duration and interest rates                            |
| **Dynamic Interest** | Rates adjust automatically based on pool utilization                                |
| **LP Rewards**       | Liquidity providers earn rewards in addition to interest                            |
| **Governance**       | Token holders can vote on protocol decisions                                        |

## How It Works

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                    VinuFinance Pool                     │
                    │  ┌─────────────────┐     ┌─────────────────┐            │
   LP Deposits      │  │  Loan Currency  │     │   Collateral    │            │
   ───────────────► │  │    (e.g. USDT)  │     │   (e.g. WVC)    │            │
                    │  └────────┬────────┘     └────────▲────────┘            │
   LP Withdrawals   │           │                       │                     │
   ◄─────────────── │           │                       │                     │
                    │           ▼                       │                     │
                    │  ┌─────────────────────────────────────────┐            │
                    │  │              Loan Mechanism              │           │
                    │  │  • Borrow: Pledge collateral, get loan  │            │
                    │  │  • Repay: Return loan + interest        │            │
                    │  │  • Default: Forfeit collateral to LPs   │            │
                    │  └─────────────────────────────────────────┘            │
                    └─────────────────────────────────────────────────────────┘
                                               │
                            Borrower           │            LP Claims
                            ◄──────────────────┴──────────────────►
```

## Protocol Components

### Core Contracts

* [**BasePool**](reference/contracts/base-pool.md) - The main lending pool contract
* [**Controller**](reference/contracts/controller.md) - Governance and revenue distribution

### Helper Contracts

* [**MultiClaim**](reference/contracts/multi-claim.md) - Batch claiming for LPs
* [**EmergencyWithdrawal**](reference/contracts/emergency-withdrawal.md) - Emergency escrow system

## Quick Links

* [Core Concepts](overview/concepts.md) - Understand the protocol mechanics
* [Providing Liquidity](guides/providing-liquidity.md) - Guide for LPs
* [Borrowing](guides/borrowing.md) - Guide for borrowers
* [Governance](guides/governance.md) - Participate in protocol governance

## VinuChain Specifics

VinuFinance is deployed on **VinuChain** (Chain ID: 207) and uses:

* **WVC** (Wrapped VinuChain) as the native wrapped token
* **USDT** as the primary stablecoin for loan pools
* **VINU** governance token for voting and rewards

## Based On

VinuFinance is a VinuChain port of [Myso Finance v1](https://github.com/mysofinance/v1-core-protocol) with additional features:

* Emergency stop support (pause/unpause)
* LP reward distribution
* Enhanced governance controls
