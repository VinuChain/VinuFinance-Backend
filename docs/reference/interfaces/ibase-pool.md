# IBasePool Interface

Interface for the BasePool lending contract.

**Source:** `contracts/interfaces/IBasePool.sol`

The legacy `creatorFee` ABI identifier denotes protocol revenue deposited with
the Controller; it is not paid to a pool creator or treasury account.

## Events

### NewSubPool

```solidity
event NewSubPool(
    IERC20 loanCcyToken,
    IERC20 collCcyToken,
    uint256 loanTenor,
    uint256 maxLoanPerColl,
    uint256 r1,
    uint256 r2,
    uint256 liquidityBnd1,
    uint256 liquidityBnd2,
    uint256 minLoan,
    uint256 creatorFee,
    address poolController,
    uint96 rewardCoefficient
)
```

Emitted when a new pool is created.

---

### AddLiquidity

```solidity
event AddLiquidity(
    address indexed lp,
    uint256 amount,
    uint256 newLpShares,
    uint256 totalLiquidity,
    uint256 totalLpShares,
    uint256 earliestRemove,
    uint256 indexed loanIdx,
    uint256 indexed referralCode
)
```

Emitted when liquidity is added to the pool.

---

### RemoveLiquidity

```solidity
event RemoveLiquidity(
    address indexed lp,
    uint256 amount,
    uint256 removedLpShares,
    uint256 totalLiquidity,
    uint256 totalLpShares,
    uint256 indexed loanIdx
)
```

Emitted when liquidity is removed from the pool.

---

### Borrow

```solidity
event Borrow(
    address indexed borrower,
    uint256 loanIdx,
    uint256 collateral,
    uint256 loanAmount,
    uint256 repaymentAmount,
    uint256 totalLpShares,
    uint256 indexed expiry,
    uint256 indexed referralCode
)
```

Emitted when a loan is taken.

---

### Repay

```solidity
event Repay(
    address indexed borrower,
    uint256 loanIdx,
    uint256 repaymentAmountAfterFees
)
```

Emitted when a loan is repaid.

---

### Claim

```solidity
event Claim(
    address indexed lp,
    uint256[] loanIdxs,
    uint256 repayments,
    uint256 collateral
)
```

Emitted when an LP claims from settled loans.

---

### Reinvest

```solidity
event Reinvest(
    address indexed lp,
    uint256 repayments,
    uint256 newLpShares,
    uint256 earliestRemove,
    uint256 indexed loanIdx
)
```

Emitted when claimed repayments are reinvested.

---

### ApprovalUpdate

```solidity
event ApprovalUpdate(
    address ownerOrBeneficiary,
    address sender,
    uint256 _packedApprovals
)
```

Emitted when approvals are updated.

## Enums

### ApprovalTypes

```solidity
enum ApprovalTypes {
    REPAY,              // 0 - Can repay loans on behalf
    ADD_LIQUIDITY,      // 1 - Can add liquidity on behalf
    REMOVE_LIQUIDITY,   // 2 - Can remove liquidity on behalf
    CLAIM,              // 3 - Can claim on behalf
    FORCE_REWARD_UPDATE // 4 - Can force reward updates
}
```

## Structs

### LpInfo

```solidity
struct LpInfo {
    uint32 fromLoanIdx;           // Earliest claimable loan index
    uint32 earliestRemove;        // Earliest removal timestamp
    uint32 currSharePtr;          // Current position in shares array
    uint256[] sharesOverTime;     // Historical share balances
    uint256[] loanIdxsWhereSharesChanged; // When shares changed
}
```

### LoanInfo

```solidity
struct LoanInfo {
    uint128 repayment;     // Amount to repay
    uint128 collateral;    // Pledged collateral
    uint128 loanAmount;    // Original loan amount
    uint128 totalLpShares; // LP shares at loan time
    uint32 expiry;         // Expiry timestamp
    bool repaid;           // Whether repaid
}
```

### ClaimInfo

```solidity
struct ClaimInfo {
    uint256 repayments;  // Total repayments claimed
    uint256 collateral;  // Total collateral claimed
    uint256 loanAmount;  // Total loan amounts claimed
}
```

### RewardRequest

```solidity
struct RewardRequest {
    address account;           // Requester
    uint128 liquidity;         // Liquidity amount
    uint32 timeSinceLastReward; // Duration
}
```

## Functions

### addLiquidity

```solidity
function addLiquidity(
    address _onBehalfOf,
    uint128 _sendAmount,
    uint256 _deadline,
    uint256 _referralCode
) external payable;
```

### removeLiquidity

```solidity
function removeLiquidity(
    address _onBehalfOf,
    uint128 numSharesRemove
) external;
```

### borrow

```solidity
function borrow(
    address _onBehalf,
    uint128 _sendAmount,
    uint128 _minLoan,
    uint128 _maxRepay,
    uint256 _deadline,
    uint256 _referralCode
) external payable;
```

### repay

```solidity
function repay(
    uint256 _loanIdx,
    address _recipient
) external payable;
```

### claim

```solidity
function claim(
    address _onBehalfOf,
    uint256[] calldata _loanIdxs,
    bool _isReinvested,
    uint256 _deadline
) external;
```

### setApprovals

```solidity
function setApprovals(
    address _approvee,
    uint256 _packedApprovals
) external;
```

### getLpInfo

```solidity
function getLpInfo(address _lpAddr) external view returns (
    uint32 fromLoanIdx,
    uint32 earliestRemove,
    uint32 currSharePtr,
    uint256[] memory sharesOverTime,
    uint256[] memory loanIdxsWhereSharesChanged
);
```

### getRateParams

```solidity
function getRateParams() external view returns (
    uint256 _liquidityBnd1,
    uint256 _liquidityBnd2,
    uint256 _r1,
    uint256 _r2
);
```

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
);
```

### loanTerms

```solidity
function loanTerms(uint128 _inAmountAfterFees) external view returns (
    uint128 loanAmount,
    uint128 repaymentAmount,
    uint128 pledgeAmount,
    uint256 _creatorFee,
    uint256 _totalLiquidity
);
```

### loanIdxToBorrower

```solidity
function loanIdxToBorrower(uint256 loanIdx) external view returns (address);
```

### isApproved

```solidity
function isApproved(
    address _ownerOrBeneficiary,
    address _sender,
    ApprovalTypes _approvalType
) external view returns (bool _approved);
```

### minLiquidity

```solidity
function minLiquidity() external view returns (uint256 _minLiquidity);
```

### collTokenDecimals

```solidity
function collTokenDecimals() external view returns (uint256 _collTokenDecimals);
```

## Related

- [BasePool Reference](../contracts/base-pool.md)
