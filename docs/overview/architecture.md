# Architecture

This page describes the smart contract architecture of VinuFinance.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VinuFinance Protocol                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐       │
│  │    BasePool     │     │    BasePool     │     │    BasePool     │       │
│  │  (USDT/WVC)     │     │  (USDT/VINU)    │     │   (WVC/TOKEN)   │       │
│  │                 │     │                 │     │                 │       │
│  │ • Loan Currency │     │ • Loan Currency │     │ • Loan Currency │       │
│  │ • Collateral    │     │ • Collateral    │     │ • Collateral    │       │
│  │ • Interest Rate │     │ • Interest Rate │     │ • Interest Rate │       │
│  │ • LP Shares     │     │ • LP Shares     │     │ • LP Shares     │       │
│  └────────┬────────┘     └────────┬────────┘     └────────┬────────┘       │
│           │                       │                       │                 │
│           └───────────────────────┼───────────────────────┘                 │
│                                   │                                         │
│                                   ▼                                         │
│                    ┌─────────────────────────────┐                          │
│                    │         Controller          │                          │
│                    │                             │                          │
│                    │ • Governance (Proposals)    │                          │
│                    │ • Revenue Distribution      │                          │
│                    │ • LP Reward Distribution    │                          │
│                    │ • Pool Whitelisting         │                          │
│                    │ • Pause/Unpause Pools       │                          │
│                    └─────────────────────────────┘                          │
│                                                                             │
│  ┌─────────────────┐                           ┌─────────────────┐         │
│  │   MultiClaim    │                           │ EmergencyWithdraw│         │
│  │                 │                           │                 │         │
│  │ Batch claiming  │                           │ Escrow-based    │         │
│  │ for LPs         │                           │ emergency exit  │         │
│  └─────────────────┘                           └─────────────────┘         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Contract Hierarchy

### Core Contracts

```
BasePool
├── IBasePool (interface)
├── IPausable (interface)
├── Pausable (OpenZeppelin)
└── SafeERC20 (OpenZeppelin)

Controller
├── IController (interface)
├── IERC165 (interface)
└── SafeERC20 (OpenZeppelin)
```

### Helper Contracts

```
MultiClaim
├── IBasePool (interface)
└── SafeERC20 (OpenZeppelin)

EmergencyWithdrawal
├── IBasePool (interface)
├── ReentrancyGuard (OpenZeppelin)
└── SafeERC20 (OpenZeppelin)
```

## Contract Interactions

### Lending Flow

```
                     User Actions                    Internal Flow
                          │                              │
    ┌─────────────────────┼──────────────────────────────┼─────────────────────┐
    │                     │                              │                     │
    │  LP adds liquidity  │                              │                     │
    │  ─────────────────► │  addLiquidity()              │                     │
    │                     │  ───────────────────────────►│ Update LP shares    │
    │                     │                              │ Update total liq    │
    │                     │                              │ Send rewards        │
    │                     │                              │                     │
    │  Borrower borrows   │                              │                     │
    │  ─────────────────► │  borrow()                    │                     │
    │                     │  ───────────────────────────►│ Calculate loan      │
    │                     │                              │ Take collateral     │
    │                     │                              │ Transfer loan       │
    │                     │                              │ Create loan record  │
    │                     │                              │                     │
    │  Borrower repays    │                              │                     │
    │  ─────────────────► │  repay()                     │                     │
    │                     │  ───────────────────────────►│ Take repayment      │
    │                     │                              │ Return collateral   │
    │                     │                              │ Mark loan repaid    │
    │                     │                              │                     │
    │  LP claims          │                              │                     │
    │  ─────────────────► │  claim()                     │                     │
    │                     │  ───────────────────────────►│ Calculate share     │
    │                     │                              │ Transfer funds      │
    │                     │                              │ Update LP state     │
    │                     │                              │                     │
    └─────────────────────┴──────────────────────────────┴─────────────────────┘
```

### Governance Flow

```
    ┌─────────────────────────────────────────────────────────────────────────┐
    │                         Controller Governance                            │
    ├─────────────────────────────────────────────────────────────────────────┤
    │                                                                         │
    │  1. User deposits vote tokens                                           │
    │     depositVoteToken() ──► voteTokenBalance[user] += amount            │
    │                                                                         │
    │  2. User creates proposal                                               │
    │     createProposal(target, action, deadline)                            │
    │     Actions: PAUSE, UNPAUSE, WHITELIST, DEWHITELIST                     │
    │                                                                         │
    │  3. Users vote on proposal                                              │
    │     vote(proposalIdx) ──► totalVotes += votingPower                    │
    │                                                                         │
    │  4. If threshold reached, proposal executes                             │
    │     PAUSE/UNPAUSE: pool.pause() or pool.unpause()                       │
    │     WHITELIST: poolWhitelisted[pool] = true                            │
    │     DEWHITELIST: poolWhitelisted[pool] = false                         │
    │                                                                         │
    │  Note: WHITELIST requires veto holder approval                          │
    │                                                                         │
    └─────────────────────────────────────────────────────────────────────────┘
```

### Revenue Distribution Flow

```
    Pool generates fees              Controller receives revenue
           │                                    │
           ▼                                    ▼
    ┌──────────────┐                 ┌─────────────────┐
    │  BasePool    │  depositRevenue │   Controller    │
    │              │ ───────────────►│                 │
    │ • Creator    │                 │ • Token         │
    │   fees       │                 │   Snapshots     │
    │              │                 │ • Revenue       │
    └──────────────┘                 │   Tracking      │
                                     └────────┬────────┘
                                              │
                                              ▼
                                     ┌─────────────────┐
                                     │  Vote Token     │
                                     │  Holders Claim  │
                                     │                 │
                                     │ Pro-rata based  │
                                     │ on staked       │
                                     │ tokens at       │
                                     │ snapshot time   │
                                     └─────────────────┘
```

## State Management

### BasePool State

| Variable | Type | Description |
|----------|------|-------------|
| `totalLiquidity` | `uint256` | Total available liquidity |
| `totalLpShares` | `uint128` | Total LP shares outstanding |
| `loanIdx` | `uint256` | Current loan index counter |
| `addrToLpInfo` | `mapping` | LP information per address |
| `loanIdxToLoanInfo` | `mapping` | Loan information per loan |
| `loanIdxToBorrower` | `mapping` | Borrower address per loan |

### Controller State

| Variable | Type | Description |
|----------|------|-------------|
| `voteTokenTotalSupply` | `uint256` | Total staked vote tokens |
| `voteTokenBalance` | `mapping` | Vote token balance per user |
| `proposals` | `mapping` | Proposal data |
| `tokenSnapshots` | `mapping` | Revenue snapshots per token |
| `poolWhitelisted` | `mapping` | Pool whitelist status |

## Security Features

### Reentrancy Protection

- `EmergencyWithdrawal` uses OpenZeppelin's `ReentrancyGuard`
- `BasePool` uses state updates before external calls

### Flash Loan Prevention

```solidity
// Prevents atomic add liquidity + borrow
mapping(address => uint256) lastAddOfTxOrigin;

// Borrowing is self-only
if (_onBehalfOf == address(0)) revert("Invalid operation.");
require(_onBehalfOf == msg.sender, "Borrower must be sender.");
// Also prevent atomic add + borrow
if (lastAddOfTxOrigin[tx.origin] == _timestamp) revert("Invalid operation.");
```

### Pausability

```solidity
// Only Controller can pause/unpause
function pause() external override {
    require(msg.sender == address(poolController), "Not the controller.");
    _pause();
}
```

### Minimum Liquidity Period

```solidity
// 120 seconds between add and remove
uint256 constant MIN_LPING_PERIOD = 120;
```

## Related

- [Core Concepts](concepts.md)
- [BasePool Reference](../reference/contracts/base-pool.md)
- [Controller Reference](../reference/contracts/controller.md)
