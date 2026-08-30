# EmergencyWithdrawal

A helper contract that allows approved escrows to withdraw funds on behalf of users in emergency situations.

**Source:** `contracts/EmergencyWithdrawal.sol`

## Overview

EmergencyWithdrawal provides a safety mechanism for users who cannot access their wallets. An approved escrow (like a trusted party or multisig) can withdraw the user's liquidity and return it to them.

## Use Cases

- **Lost Private Key**: User can recover funds via approved escrow
- **Smart Contract Wallet Issue**: Backup recovery mechanism
- **Institutional Custody**: Compliance or legal requirements

## Security Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    Emergency Withdrawal Flow                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. User pre-approves an escrow (while they have access)        │
│     user ──► approve(pool, escrow)                              │
│                                                                 │
│  2. If emergency occurs, escrow can withdraw                    │
│     escrow ──► collectEmergency(pool, user)                     │
│                     │                                           │
│                     ▼                                           │
│     ┌─────────────────────────────────────────┐                │
│     │  EmergencyWithdrawal                    │                │
│     │  • Verifies escrow is approved by user  │                │
│     │  • Calls pool.removeLiquidity(user)     │                │
│     │  • Transfers tokens to user (not escrow)│                │
│     └─────────────────────────────────────────┘                │
│                                                                 │
│  Note: Funds always go to original user, not escrow             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key Security Properties:**
- Escrow can only withdraw, never receive funds
- Funds are always transferred to the original user
- Each pool requires separate approval
- User can unapprove at any time

## Functions

### approve

```solidity
function approve(address _pool, address _escrow) external
```

Approves an escrow to withdraw on behalf of the caller.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_pool` | `address` | Pool to approve for |
| `_escrow` | `address` | Address to grant withdrawal rights |

**Example:**

```javascript
// User approves a multisig as emergency escrow
await emergencyWithdrawal.approve(poolAddress, multisigAddress);
```

---

### unapprove

```solidity
function unapprove(address _pool, address _escrow) external
```

Revokes an escrow's withdrawal rights.

---

### isApproved

```solidity
function isApproved(
    address _user,
    address _pool,
    address _escrow
) public view returns (bool)
```

Checks if an escrow is approved by a user for a specific pool.

---

### collectEmergency

```solidity
function collectEmergency(
    IBasePool _pool,
    address _onBehalfOf
) external
```

Withdraws the user's currently removable LP liquidity and sends it to the original user; unsettled or remaining claims are handled separately.

The helper reads `BasePool.getCurrentLpShares()` rather than copying the LP's
full share history, so an attacker-grown history does not make an emergency
exit's entitlement lookup scale with array length.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_pool` | `IBasePool` | Pool to withdraw from |
| `_onBehalfOf` | `address` | User whose funds to withdraw |

**Requirements:**
- Caller must be approved escrow for user/pool combination
- User must have LP shares in the pool

**Effects:**
1. Calls `pool.removeLiquidity()` for the user's currently removable shares
2. Transfers received tokens to `_onBehalfOf` (not caller)

**Reverts if:**
- Caller not approved as escrow
- User has no shares

**Example:**

```javascript
// Escrow withdraws funds for user (sends to user, not escrow)
await emergencyWithdrawal.collectEmergency(poolAddress, userAddress);
```

## Setup Requirements

The EmergencyWithdrawal contract must be approved in the pool:

```javascript
// User must approve EmergencyWithdrawal for REMOVE_LIQUIDITY
// Bit 2 = 4
await pool.setApprovals(emergencyWithdrawalAddress, 4);
```

## Events

### Approved

```solidity
event Approved(
    address indexed user,
    address indexed pool,
    address indexed escrow
)
```

Emitted when a user approves an escrow.

---

### Unapproved

```solidity
event Unapproved(
    address indexed user,
    address indexed pool,
    address indexed escrow
)
```

Emitted when a user revokes escrow approval.

---

### Withdrawal

```solidity
event Withdrawal(
    address indexed user,
    address indexed pool,
    address indexed escrow,
    IERC20 token,
    uint256 amount
)
```

Emitted when an emergency withdrawal occurs.

## Best Practices

### For Users

1. **Choose escrows carefully** - Only approve trusted parties
2. **Use multisigs** - Single points of failure are risky
3. **Document your setup** - Keep records of approvals
4. **Test beforehand** - Verify setup while you have access

### For Escrows

1. **Verify identity** - Confirm user identity before withdrawal
2. **Act promptly** - Emergency situations may be time-sensitive
3. **Keep records** - Document all emergency actions

## Limitations

- Only withdraws LP position (not pending claims)
- User must have approved both:
  - Escrow in EmergencyWithdrawal contract
  - EmergencyWithdrawal in pool's approval system
- Cannot bypass MIN_LPING_PERIOD

## Error Messages

| Error | Meaning |
|-------|---------|
| `Not approved` | Caller is not approved escrow for user/pool |
| `No shares` | User has no LP shares to withdraw |

## Related

- [BasePool Reference](base-pool.md)
- [Providing Liquidity Guide](../../guides/providing-liquidity.md)
