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
│  3. Create BasePool(s) through Controller                        │
│     └─► Records construction provenance before whitelisting      │
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
- [ ] VinuExplorer URL/API checked (`https://mainnet.vinuexplorer.org`)
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

The Controller has eight constructor arguments. It derives and stores
`basePoolCreationCodeHash` internally as
`keccak256(type(BasePool).creationCode)`; callers do not supply a hash.

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
2. Confirm `basePoolCreationCodeHash` equals
   `keccak256(type(BasePool).creationCode)` from the audited release artifact
   (the equivalent Hardhat value is `ethers.utils.keccak256(BasePool.bytecode)`)
3. Transfer veto holder to multisig (if not already)
4. Test deposit/withdraw vote tokens
5. Document the creation-code hash in the structured deployment record

## BasePool Deployment

Create each production pool through `Controller.createPool`. The Controller
accepts only the exact supplied `BasePool` creation code, checks the deployed
pool's `poolController()` binding, and records the pool in `poolRegistered`
before governance can whitelist it.

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
const controller = await ethers.getContractAt("Controller", controllerAddress);
const BasePool = await ethers.getContractFactory("BasePool");
const encoded = ethers.utils.defaultAbiCoder.encode([
    "address[]", "uint256", "uint256", "uint256", "uint256[]", "uint256[]",
    "uint256", "uint256", "uint256", "address", "uint96",
], [["0x...", "0x..."],                  // [USDT address, WVC address]
    18,                                      // WVC has 18 decimals
    2592000,                                 // 30 days in seconds
    ethers.utils.parseUnits("0.5", 6),      // 0.5 USDT per WVC (USDT has 6 decimals)
    [ethers.utils.parseUnits("0.15", 18), ethers.utils.parseUnits("0.02", 18)],
    [ethers.utils.parseUnits("10000", 6), ethers.utils.parseUnits("100000", 6)],
    ethers.utils.parseUnits("100", 6),      // 100 USDT min loan
    ethers.utils.parseUnits("0.01", 18),    // 1% protocol fee (legacy _creatorFee)
    ethers.utils.parseUnits("1000", 6),     // 1000 USDT min liquidity
    controller.address,
    ethers.utils.parseUnits("1", 18)        // Reward coefficient
]);
const tx = await controller.createPool(BasePool.bytecode, encoded, { gasLimit: 8_000_000 });
const receipt = await tx.wait();
const event = receipt.events.find((item) => item.event === "PoolCreated");
if (!event) throw new Error("PoolCreated event missing");
const pool = BasePool.attach(event.args.pool);
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

| Contract / operation | Deployment Gas |
|----------------------|----------------|
| Controller | ~4,064,000 |
| `Controller.createPool` (BasePool, measured) | ~4,999,603 |
| MultiClaim | ~500,000 |
| EmergencyWithdrawal | ~800,000 |

### Gas Optimization

- Deploy during low gas periods
- Use optimizer with high runs (200+)
- Consider batch deployment scripts

The repository's release build is pinned to solc `0.8.36`, EVM target
`cancun`, optimizer runs `200`, Yul enabled, and metadata bytecode hashes
disabled in both Hardhat and Foundry. Run `yarn verify:compiler` to compare the
resolved settings and deployed bytecode before deployment.

## Verification

### Verify on Block Explorer

Submit the exact deployment-era standard JSON compiler input and constructor
arguments to the explorer. Do not use this generic guide’s illustrative values
or the current checkout to verify an immutable legacy address; use
[`legacy-vinuchain.md`](legacy-vinuchain.md) for that release record. The
original legacy artifact and metadata remain an external prerequisite for any
pool source verification.
VinuChain mainnet (chain ID 207) uses VinuExplorer's public Blockscout-
compatible API. The repository registers the API at
`https://mainnet.vinuexplorer.org/api` and the browser at
`https://mainnet.vinuexplorer.org`; no explorer API key is required. Check the
registration without submitting a verification request:

```bash
yarn verify:network
```

After reviewing the deployment address and constructor arguments, use the
exact Controller and array-argument commands in
[VinuChain Deployment](vinuchain.md#using-hardhat). Do not flatten array
arguments into positional strings.

### Manual Verification

If automatic verification fails:

1. Open `https://mainnet.vinuexplorer.org` and choose **Verify Contract**
2. Select **Solidity (Standard JSON-Input)**
3. Upload the standard JSON input from `artifacts/build-info/`
4. Match solc `0.8.36`, EVM `cancun`, optimizer runs `200`, Yul enabled, and
   metadata bytecode hash `none`

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
            "blockNumber": 12345,
            "verification": false
        },
        "BasePool": {
            "address": "0x...",
            "txHash": "0x...",
            "blockNumber": 12346,
            "verification": false
        },
        "MultiClaim": {
            "address": "0x...",
            "txHash": "0x...",
            "blockNumber": 12347,
            "verification": false
        },
        "EmergencyWithdrawal": {
            "address": "0x...",
            "txHash": "0x...",
            "blockNumber": 12348,
            "verification": false
        }
    }
}
```

`BasePool.txHash` is the `Controller.createPool` transaction that emitted the
`PoolCreated` event. The deployment script writes `verification: false` until
the exact deployment-era source and constructor arguments are verified.

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
