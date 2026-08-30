# Deployment Overview

This guide covers deploying VinuFinance contracts to production networks.

## Deployment Order

Contracts must be deployed in a specific order due to dependencies:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Deployment Sequence                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Deploy ERC20 tokens (if not existing)                       │
│     ├─► Vote token (governance)                                 │
│     ├─► Loan token (USDT, etc.)                                 │
│     └─► Collateral token (WVC, etc.)                            │
│                                                                  │
│  2. Deploy Controller                                            │
│     └─► Requires: Vote token address, veto holder address       │
│                                                                  │
│  3. Deploy BasePool(s)                                           │
│     └─► Requires: Loan token, collateral token, Controller      │
│                                                                  │
│  4. Deploy Helpers (optional)                                    │
│     ├─► MultiClaim                                              │
│     └─► EmergencyWithdrawal                                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Pre-Deployment Checklist

### 1. Configuration

- [ ] All parameters calculated and verified
- [ ] Interest rate model tested
- [ ] Fee percentages confirmed
- [ ] Token decimals verified

### 2. Security

- [ ] Contracts audited
- [ ] Test coverage > 90%
- [ ] Admin keys secured (multisig recommended)
- [ ] Emergency procedures documented

### 3. Environment

- [ ] RPC URL configured
- [ ] Deployer wallet funded
- [ ] Block explorer API key ready
- [ ] Gas price oracle checked

## Controller Deployment

### Constructor Parameters

```solidity
constructor(
    IERC20 _voteToken,            // Governance token address
    uint256 _pauseThreshold,      // Threshold for pause proposals (out of 10000)
    uint256 _unpauseThreshold,    // Threshold for unpause proposals
    uint256 _whitelistThreshold,  // Threshold for whitelist proposals
    uint256 _dewhitelistThreshold,// Threshold for dewhitelist proposals
    uint256 _snapshotEvery,       // Seconds between token snapshots
    uint256 _lockPeriod,          // Seconds before user can withdraw
    address _vetoHolder           // Address with veto power
)
```

### Example

```javascript
const Controller = await ethers.getContractFactory("Controller");
const controller = await Controller.deploy(
    "0x...",    // Vote token address
    5000,       // 50% pause threshold
    5000,       // 50% unpause threshold
    5000,       // 50% whitelist threshold
    5000,       // 50% dewhitelist threshold
    86400,      // Snapshot every 24 hours
    604800,     // 7 day lock period
    "0x..."     // Veto holder (DAO multisig recommended)
);
await controller.deployed();
console.log("Controller deployed to:", controller.address);
```

### Post-Deployment

1. Verify contract on block explorer
2. Transfer veto holder to multisig (if not already)
3. Test deposit/withdraw vote tokens
4. Document address in deployment records

## BasePool Deployment

### Constructor Parameters

```solidity
constructor(
    IERC20[] memory _tokens,        // [loanCcyToken, collCcyToken]
    uint256 _collTokenDecimals,     // Decimals of collateral token
    uint256 _loanTenor,             // Loan duration in seconds
    uint256 _maxLoanPerColl,        // Max loan per collateral unit
    uint256[] memory _rs,           // [r1, r2] interest rates (in BASE)
    uint256[] memory _liquidityBnds,// [liquidityBnd1, liquidityBnd2]
    uint256 _minLoan,               // Minimum loan amount
    uint256 _creatorFee,            // Legacy ABI name: protocol fee (max 3%)
    uint256 _minLiquidity,          // Minimum liquidity (at least 1000)
    IController _poolController,    // Controller address
    uint96 _rewardCoefficient       // LP reward coefficient
)
```

`_creatorFee` retains its legacy ABI name but is protocol revenue: each borrow
deducts it from collateral and the pool deposits it to the Controller. It is
not paid to the pool creator.

### Parameter Calculation

See [Creating Pools](creating-pools.md) for detailed parameter calculation.

### Example

```javascript
const BasePool = await ethers.getContractFactory("BasePool");
const pool = await BasePool.deploy(
    ["0x...", "0x..."],             // [USDT address, WVC address]
    18,                              // WVC has 18 decimals
    2592000,                         // 30 days in seconds
    ethers.utils.parseUnits("0.5", 18), // 0.5 loan per coll
    [                                // Interest rates array (r1 > r2 required)
        ethers.utils.parseUnits("0.15", 18), // r1 = 15% (rate at low available liquidity)
        ethers.utils.parseUnits("0.02", 18)  // r2 = 2%  (minimum rate)
    ],
    [                                // Liquidity bounds array
        ethers.utils.parseUnits("10000", 6),  // 10k USDT bnd1
        ethers.utils.parseUnits("100000", 6)  // 100k USDT bnd2
    ],
    ethers.utils.parseUnits("100", 6),    // 100 USDT min loan
    ethers.utils.parseUnits("0.01", 18),  // 1% protocol fee (legacy _creatorFee)
    ethers.utils.parseUnits("1000", 6),   // 1000 USDT min liquidity
    controllerAddress,
    ethers.utils.parseUnits("1", 18)      // Reward coefficient
);
```

`_creatorFee` is the legacy ABI/config identifier for the protocol fee. It is
deducted from collateral and deposited as Controller protocol revenue for
vote-token snapshot distribution; it is not paid to the pool creator or a
treasury.

## Helper Contract Deployment

### MultiClaim

```javascript
const MultiClaim = await ethers.getContractFactory("MultiClaim");
const multiClaim = await MultiClaim.deploy();
await multiClaim.deployed();
```

### EmergencyWithdrawal

```javascript
const EmergencyWithdrawal = await ethers.getContractFactory("EmergencyWithdrawal");
const emergency = await EmergencyWithdrawal.deploy();
await emergency.deployed();
```

## Gas Considerations

### Estimated Gas Costs

| Contract | Deployment Gas |
|----------|----------------|
| Controller | ~3,000,000 |
| BasePool | ~4,500,000 |
| MultiClaim | ~500,000 |
| EmergencyWithdrawal | ~800,000 |

### Gas Optimization

- Deploy during low gas periods
- Use optimizer with high runs (200+)
- Consider batch deployment scripts

## Verification

### Verify on Block Explorer

Submit the exact deployment-era standard JSON compiler input and constructor
arguments to the explorer. Do not use this generic guide’s illustrative values
or the current checkout to verify an immutable legacy address; use
[`legacy-vinuchain.md`](legacy-vinuchain.md) for that release record. The
original legacy artifact and metadata remain an external prerequisite for any
pool source verification.

### Manual Verification

If automatic verification fails:

1. Flatten contract source
2. Upload manually to explorer
3. Match compiler settings exactly

## Post-Deployment Tasks

### Immediate

1. [ ] Verify all contracts on block explorer
2. [ ] Test basic functions (deposit, withdraw)
3. [ ] Confirm Controller can pause pools
4. [ ] Update frontend with new addresses

### Short-Term

1. [ ] Create governance proposal for whitelisting
2. [ ] Seed initial liquidity
3. [ ] Monitor first loans
4. [ ] Document any issues

### Ongoing

1. [ ] Monitor pool utilization
2. [ ] Track governance proposals
3. [ ] Review security alerts
4. [ ] Plan parameter updates

## Deployment Records

Maintain records for each deployment:

```json
{
    "network": "vinuchain",
    "chainId": 207,
    "deployer": "0x...",
    "timestamp": "2024-01-01T00:00:00Z",
    "contracts": {
        "Controller": {
            "address": "0x...",
            "txHash": "0x...",
            "blockNumber": 12345
        },
        "BasePool_USDT_WVC": {
            "address": "0x...",
            "txHash": "0x...",
            "blockNumber": 12346
        }
    },
    "verification": {
        "Controller": true,
        "BasePool_USDT_WVC": true
    }
}
```

## Rollback Plan

If issues are discovered:

### Minor Issues

1. Pause affected pools via governance
2. Deploy fixed version
3. Migrate liquidity to new pools
4. Dewhitelist old pools

### Critical Issues

1. Pause all pools immediately
2. Use EmergencyWithdrawal if needed
3. Communicate with users
4. Audit and fix issues
5. Redeploy entire system

## Related

- [VinuChain Deployment](vinuchain.md)
- [Creating Pools](creating-pools.md)
- [Security](../resources/security.md)
