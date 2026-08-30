# IPausable Interface

Interface for pausable pool contracts.

**Source:** `contracts/interfaces/IPausable.sol`

## Overview

The IPausable interface defines the pause/unpause functionality that allows the Controller to halt pool operations during emergencies.

## Functions

### pause

```solidity
function pause() external;
```

Pauses selected pool operations during an emergency. In `BasePool`, adding
liquidity, borrowing, and claim reinvestment are paused; exits and repayment
remain available.

**Access:** Only callable by the Controller contract.

**Effects:**
- Sets paused state to true
- `addLiquidity()` and `borrow()` revert while paused
- `claim(..., true, ...)` (reinvestment) reverts while paused
- `removeLiquidity()`, `repay()`, claim-only calls (`claim(..., false, ...)`),
  `forceRewardUpdate()`, and approved `EmergencyWithdrawal.collectEmergency()`
  remain operational

### unpause

```solidity
function unpause() external;
```

Unpauses the contract, resuming normal operations.

**Access:** Only callable by the Controller contract.

## Usage in BasePool

```solidity
contract BasePool is IBasePool, Pausable, IPausable {

    function addLiquidity(...) external payable whenNotPaused { ... }

    function borrow(...) external payable whenNotPaused { ... }

    function claim(..., bool _isReinvested, ...) external {
        if (_isReinvested) require(!paused(), "Pausable: paused");
    }

    function pause() external override {
        require(msg.sender == address(poolController), "Not the controller.");
        _pause();
    }

    function unpause() external override {
        require(msg.sender == address(poolController), "Not the controller.");
        _unpause();
    }
}
```

## When Paused

| Function | Available? |
|----------|------------|
| `addLiquidity()` | **No** |
| `removeLiquidity()` | Yes |
| `borrow()` | **No** |
| `repay()` | Yes |
| `claim(..., false, ...)` (claim-only) | Yes |
| `claim(..., true, ...)` (reinvest) | **No** |
| `forceRewardUpdate()` | Yes |
| `EmergencyWithdrawal.collectEmergency()` (approved exit) | Yes* |

\* The emergency helper still requires an approved escrow and removable LP
shares; it calls `removeLiquidity`, which is not pause-gated.

## Governance Flow

```
┌────────────────────────────────────────────────────────────────┐
│                    Pause Flow                                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  1. User creates PAUSE proposal                                │
│     controller.createProposal(pool, PAUSE, deadline)           │
│                                                                │
│  2. Token holders vote                                         │
│     controller.vote(proposalIdx)                               │
│                                                                │
│  3. If threshold reached, proposal executes                    │
│     proposals[idx].target.pause() ──► pool._pause()           │
│                                                                │
│  4. Pool is now paused                                         │
│     addLiquidity(), borrow(), and reinvested claims revert       │
│     with "Pausable: paused"                                     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Related

- [Controller Reference](../contracts/controller.md)
- [BasePool Reference](../contracts/base-pool.md)
- [Governance Guide](../../guides/governance.md)
