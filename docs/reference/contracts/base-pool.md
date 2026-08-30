# BasePool

The BasePool contract is the core lending pool that handles liquidity provision, borrowing, repayment, and claim distribution.

**Source:** `contracts/BasePool.sol`

## Overview

BasePool implements VinuFinance's Zero Liquidation Lending model where:
- LPs deposit loan currency and earn yield
- Borrowers pledge collateral to receive loans
- Loans are either repaid or default (no liquidations)

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_LPING_PERIOD` | 120 | Minimum seconds between add and remove liquidity |
| `MIN_TENOR` | 86400 | Minimum loan duration (1 day) |
| `BASE` | 10^18 | Precision for rate calculations |
| `MAX_FEE` | 3×10^16 | Maximum protocol revenue fee (3%) |

## State Variables

### Pool Configuration

| Variable | Type | Description |
|----------|------|-------------|
| `loanCcyToken` | `IERC20` | Loan currency token |
| `collCcyToken` | `IERC20` | Collateral token |
| `poolController` | `IController` | Controller contract address |
| `loanTenor` | `uint256` | Loan duration in seconds |
| `maxLoanPerColl` | `uint256` | Maximum loan per collateral unit |
| `minLoan` | `uint256` | Minimum loan size |
| `minLiquidity` | `uint256` | Minimum required liquidity |
| `collTokenDecimals` | `uint256` | Collateral token decimals |
| `creatorFee` | `uint256` | Protocol revenue fee percentage (in BASE) |
| `rewardCoefficient` | `uint96` | LP reward multiplier applied to raw loan-token liquidity; configure scaling for 6-decimal loan pools |

### Rate Parameters

| Variable | Type | Description |
|----------|------|-------------|
| `r1` | `uint256` | High rate (per tenor) |
| `r2` | `uint256` | Low rate (per tenor) |
| `liquidityBnd1` | `uint256` | Lower liquidity bound |
| `liquidityBnd2` | `uint256` | Upper liquidity bound |

### Pool State

| Variable | Type | Description |
|----------|------|-------------|
| `totalLiquidity` | `uint256` | Total pool liquidity |
| `totalLpShares` | `uint128` | Total LP shares |
| `loanIdx` | `uint256` | Current loan index |

## Functions

### addLiquidity

```solidity
function addLiquidity(
    address _onBehalfOf,
    uint128 _sendAmount,
    uint256 _deadline,
    uint256 _referralCode
) external payable
```

Adds liquidity to the pool.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_onBehalfOf` | `address` | Recipient of LP shares |
| `_sendAmount` | `uint128` | Amount of loan currency to deposit |
| `_deadline` | `uint256` | Transaction deadline |
| `_referralCode` | `uint256` | Optional referral identifier |

**Effects:**
- Transfers loan currency from sender
- Mints LP shares to `_onBehalfOf`
- Updates reward tracking
- Sets earliest removal time

**Example:**

```javascript
const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
await pool.addLiquidity(
    userAddress,
    ethers.utils.parseUnits('1000', 6), // 1000 USDT
    deadline,
    0 // no referral
);
```

---

### removeLiquidity

```solidity
function removeLiquidity(
    address _onBehalfOf,
    uint128 numShares
) external
```

Removes liquidity by burning LP shares.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_onBehalfOf` | `address` | Owner of LP shares |
| `numShares` | `uint128` | Number of shares to remove |

**Reverts if:**
- `numShares` exceeds LP's balance
- Called before `earliestRemove` timestamp
- Sender not approved

---

### borrow

```solidity
function borrow(
    address _onBehalfOf,
    uint128 _sendAmount,
    uint128 _minLoanLimit,
    uint128 _maxRepayLimit,
    uint256 _deadline,
    uint256 _referralCode
) external payable
```

Borrows from the pool by pledging collateral.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_onBehalfOf` | `address` | Loan recipient |
| `_sendAmount` | `uint128` | Collateral amount to pledge |
| `_minLoanLimit` | `uint128` | Minimum acceptable loan |
| `_maxRepayLimit` | `uint128` | Maximum acceptable repayment |
| `_deadline` | `uint256` | Transaction deadline |
| `_referralCode` | `uint256` | Optional referral identifier |

**Reverts if:**
- Pool is paused
- Loan amount below `_minLoanLimit`
- Repayment above `_maxRepayLimit`
- Atomic add+borrow detected

**Example:**

```javascript
const deadline = Math.floor(Date.now() / 1000) + 3600;
await pool.borrow(
    borrowerAddress,
    ethers.utils.parseEther('10'),    // 10 WVC collateral
    ethers.utils.parseUnits('50', 6), // Min 50 USDT loan
    ethers.utils.parseUnits('60', 6), // Max 60 USDT repayment
    deadline,
    0
);
```

---

### repay

```solidity
function repay(
    uint256 _loanIdx,
    address _recipient
) external payable
```

Repays a loan to reclaim collateral.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_loanIdx` | `uint256` | Index of the loan to repay |
| `_recipient` | `address` | Recipient of returned collateral |

**Reverts if:**
- Loan index invalid
- Called after expiry
- Already repaid
- Repay in same block as borrow

---

### claim

```solidity
function claim(
    address _onBehalfOf,
    uint256[] calldata _loanIdxs,
    bool _isReinvested,
    uint256 _deadline
) external
```

Claims LP's share from settled loans.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_onBehalfOf` | `address` | LP to claim for |
| `_loanIdxs` | `uint256[]` | Array of loan indices (ascending) |
| `_isReinvested` | `bool` | Whether to reinvest repayments |
| `_deadline` | `uint256` | Deadline (only used if reinvesting) |

**Reverts if:**
- Loan indices not ascending
- Loans not settled (not repaid and not expired)
- LP has no shares for those loans

---

### setApprovals

```solidity
function setApprovals(
    address _approvee,
    uint256 _packedApprovals
) external
```

Sets approval permissions for another address.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `_approvee` | `address` | Address to approve |
| `_packedApprovals` | `uint256` | Packed approval bits |

**Approval Bits:**

| Bit | Value | Permission |
|-----|-------|------------|
| 0 | 1 | REPAY |
| 1 | 2 | ADD_LIQUIDITY |
| 2 | 4 | REMOVE_LIQUIDITY |
| 3 | 8 | CLAIM |
| 4 | 16 | FORCE_REWARD_UPDATE |

**Example:**

```javascript
// Approve address to add liquidity and claim (bits 1 and 3)
// Binary: 01010 = 10 decimal
await pool.setApprovals(helperContract, 10);
```

---

### forceRewardUpdate

```solidity
function forceRewardUpdate(address _onBehalfOf) external
```

Forces an update of reward tracking for an account.

---

## View Functions

### getLpInfo

```solidity
function getLpInfo(address _lpAddr) external view returns (
    uint32 fromLoanIdx,
    uint32 earliestRemove,
    uint32 currSharePtr,
    uint256[] memory sharesOverTime,
    uint256[] memory loanIdxsWhereSharesChanged
)
```

Returns complete LP information.

---

### getRateParams

```solidity
function getRateParams() external view returns (
    uint256 _liquidityBnd1,
    uint256 _liquidityBnd2,
    uint256 _r1,
    uint256 _r2
)
```

Returns interest rate parameters.

---

### getPoolInfo

```solidity
function getPoolInfo() external view returns (
    IERC20 _loanCcyToken,
    IERC20 _collCcyToken,
    uint256 _maxLoanPerColl,
    uint256 _minLoan,
    uint256 _loanTenor,
    uint256 _totalLiquidity,
    uint256 _totalLpShares,
    uint96 _rewardCoefficient,
    uint256 _loanIdx
)
```

Returns pool configuration and state.

---

### loanTerms

```solidity
function loanTerms(uint128 _inAmountAfterFees) public view returns (
    uint128 loanAmount,
    uint128 repaymentAmount,
    uint128 pledgeAmount,
    uint256 _creatorFee,
    uint256 _totalLiquidity
)
```

Calculates loan terms for a given collateral amount.

---

### loanIdxToLoanInfo

```solidity
mapping(uint256 => LoanInfo) public loanIdxToLoanInfo;
```

Public mapping storing loan information by loan index. Solidity auto-generates a getter function for this mapping.

---

## Events

| Event | Description |
|-------|-------------|
| `NewSubPool` | Emitted on pool creation |
| `AddLiquidity` | Emitted when liquidity is added |
| `RemoveLiquidity` | Emitted when liquidity is removed |
| `Borrow` | Emitted on new loan |
| `Repay` | Emitted on loan repayment |
| `Claim` | Emitted when LP claims |
| `Reinvest` | Emitted when claims are reinvested |
| `ApprovalUpdate` | Emitted when approvals change |

## Error Messages

| Error | Meaning |
|-------|---------|
| `Past deadline.` | Transaction deadline exceeded |
| `Sender not approved.` | Caller lacks required approval |
| `Too early to remove.` | MIN_LPING_PERIOD not elapsed |
| `Invalid operation.` | Atomic add+borrow detected |
| `Insufficient liquidity.` | Pool cannot cover loan |
| `Loan too small.` | Below minimum loan size |
| `Cannot repay after expiry.` | Loan has defaulted |
| `Already repaid.` | Loan already settled |
| `Cannot claim with unsettled loan.` | Loan not repaid/expired |

## Related

- [IBasePool Interface](../interfaces/ibase-pool.md)
- [Controller Reference](controller.md)
- [Providing Liquidity Guide](../../guides/providing-liquidity.md)
