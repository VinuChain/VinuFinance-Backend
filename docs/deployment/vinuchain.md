# VinuChain Deployment

This guide covers VinuFinance deployment specifics for VinuChain.

## VinuChain Network

| Property | Value |
|----------|-------|
| Chain ID | 207 |
| Native Token | VC (VinuChain) |
| Wrapped Native | WVC (Wrapped VinuChain) |
| Block Time | ~3 seconds |
| Consensus | Proof of Stake (PoS) |

## Network Configuration

### Hardhat Config

```javascript
// hardhat.config.js
module.exports = {
    networks: {
        vinuchain: {
            url: process.env.VINUCHAIN_RPC_URL || "https://rpc.vinuchain.org",
            chainId: 207,
            accounts: [process.env.PRIVATE_KEY],
            gasPrice: "auto"
        }
    }
};
```

### MetaMask Setup

Add VinuChain to MetaMask:

| Setting | Value |
|---------|-------|
| Network Name | VinuChain |
| RPC URL | https://rpc.vinuchain.org |
| Chain ID | 207 |
| Symbol | VC |
| Explorer | https://vinuexplorer.org |

## Token Addresses

### Core Tokens

| Token | Address | Decimals |
|-------|---------|----------|
| WVC (Wrapped VC) | `0xEd8c5530a0A086a12f57275728128a60DFf04230` | 18 |
| USDT | `0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41` | 6 |
| VINU (Governance) | `0x00c1E515EA9579856304198EFb15f525A0bb50f6` | 18 |

## Deployment Script

### Complete Deployment

```javascript
// scripts/deploy-vinuchain.js
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying to VinuChain with:", deployer.address);
    console.log("Balance:", ethers.utils.formatEther(
        await deployer.getBalance()
    ), "VC");

    // Token addresses
    const VINU_ADDRESS = "0x00c1E515EA9579856304198EFb15f525A0bb50f6";
    const WVC_ADDRESS = "0xEd8c5530a0A086a12f57275728128a60DFf04230";
    const USDT_ADDRESS = "0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41";

    // Deploy Controller (8 parameters)
    console.log("\n1. Deploying Controller...");
    const Controller = await ethers.getContractFactory("Controller");
    const controller = await Controller.deploy(
        VINU_ADDRESS,         // _voteToken
        5000,                 // _pauseThreshold (50%)
        5000,                 // _unpauseThreshold
        5000,                 // _whitelistThreshold
        5000,                 // _dewhitelistThreshold
        86400,                // _snapshotEvery (1 day)
        604800,               // _lockPeriod (7 days)
        deployer.address      // _vetoHolder (temporary)
    );
    await controller.deployed();
    console.log("Controller:", controller.address);

    // Deploy BasePool (USDT/WVC) - 11 parameters with arrays
    console.log("\n2. Deploying BasePool (USDT/WVC)...");
    const BasePool = await ethers.getContractFactory("BasePool");
    const pool = await BasePool.deploy(
        [USDT_ADDRESS, WVC_ADDRESS],         // _tokens array
        18,                                   // _collTokenDecimals
        2592000,                             // _loanTenor (30 days)
        ethers.utils.parseUnits("0.5", 18),  // _maxLoanPerColl
        [                                    // _rs array — r1 > r2 required (r1 = rate at low liquidity, r2 = min rate)
            ethers.utils.parseUnits("0.15", 18), // r1 = 15% (rate at low available liquidity)
            ethers.utils.parseUnits("0.02", 18)  // r2 = 2%  (minimum rate)
        ],
        [                                    // _liquidityBnds array
            ethers.utils.parseUnits("10000", 6), // 10k USDT bnd1
            ethers.utils.parseUnits("100000", 6) // 100k USDT bnd2
        ],
        ethers.utils.parseUnits("100", 6),   // _minLoan
        ethers.utils.parseUnits("0.01", 18), // _creatorFee (1%)
        ethers.utils.parseUnits("1000", 6),  // _minLiquidity
        controller.address,                  // _poolController
        ethers.utils.parseUnits("1", 18)     // _rewardCoefficient
    );
    await pool.deployed();
    console.log("BasePool (USDT/WVC):", pool.address);

    // Deploy helpers
    console.log("\n3. Deploying helpers...");
    const MultiClaim = await ethers.getContractFactory("MultiClaim");
    const multiClaim = await MultiClaim.deploy();
    await multiClaim.deployed();
    console.log("MultiClaim:", multiClaim.address);

    // Summary
    console.log("\n========== DEPLOYMENT SUMMARY ==========");
    console.log("Network: VinuChain (chainId: 207)");
    console.log("Controller:", controller.address);
    console.log("BasePool:", pool.address);
    console.log("MultiClaim:", multiClaim.address);
    console.log("=========================================");

    // Save addresses
    const fs = require("fs");
    const addresses = {
        network: "vinuchain",
        chainId: 207,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        contracts: {
            Controller: controller.address,
            "BasePool_USDT_WVC": pool.address,
            MultiClaim: multiClaim.address
        }
    };
    fs.writeFileSync(
        "deployments/vinuchain.json",
        JSON.stringify(addresses, null, 2)
    );
    console.log("\nAddresses saved to deployments/vinuchain.json");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
```

### Run Deployment

```bash
npx hardhat run scripts/deploy-vinuchain.js --network vinuchain
```

## Contract Verification

### Using Hardhat

For contracts with array parameters, create a constructor arguments file:

**1. Controller Verification**

```bash
# Controller has 8 parameters (no arrays)
npx hardhat verify --network vinuchain \
    CONTROLLER_ADDRESS \
    "VINU_ADDRESS" \
    5000 \
    5000 \
    5000 \
    5000 \
    86400 \
    604800 \
    "VETO_HOLDER_ADDRESS"
```

**2. BasePool Verification**

Since BasePool uses array parameters, create a file `arguments.js`:

```javascript
// arguments.js
module.exports = [
    ["USDT_ADDRESS", "WVC_ADDRESS"],           // _tokens array
    18,                                         // _collTokenDecimals
    2592000,                                   // _loanTenor
    "500000000000000000",                      // _maxLoanPerColl
    ["150000000000000000", "20000000000000000"], // _rs array [r1, r2] = [15%, 2%] (r1 > r2)
    ["10000000000", "100000000000"],           // _liquidityBnds array
    "100000000",                               // _minLoan
    "10000000000000000",                       // _creatorFee
    "1000000000",                              // _minLiquidity
    "CONTROLLER_ADDRESS",                      // _poolController
    "1000000000000000000"                      // _rewardCoefficient
];
```

Then verify:

```bash
npx hardhat verify --network vinuchain \
    --constructor-args arguments.js \
    POOL_ADDRESS
```

### Manual Verification

If automatic verification fails:

1. Go to VinuChain Explorer
2. Navigate to contract address
3. Click "Verify Contract"
4. Select "Solidity (Standard JSON-Input)"
5. Upload build artifacts from `artifacts/build-info/`

## Gas Costs on VinuChain

VinuChain has low gas costs:

| Operation | Estimated Gas | Cost (at 1 gwei) |
|-----------|---------------|------------------|
| Controller Deploy | ~3M | ~0.003 VC |
| BasePool Deploy | ~4.5M | ~0.0045 VC |
| Add Liquidity | ~200k | ~0.0002 VC |
| Borrow | ~250k | ~0.00025 VC |
| Repay | ~150k | ~0.00015 VC |
| Claim | ~100k + 50k/loan | Variable |

## Recommended Pool Parameters

### Conservative Pool (USDT/WVC)

```javascript
{
    loanTenor: 2592000,        // 30 days
    maxLoanPerColl: 0.3,       // 30% LTV
    r1: 0.12,                  // 12% rate at low available liquidity (must exceed r2)
    r2: 0.02,                  // 2% minimum rate
    liquidityBnd1: 50000,      // 50k USDT
    liquidityBnd2: 200000,     // 200k USDT
    minLoan: 100,              // 100 USDT
    creatorFee: 0.005          // 0.5%
}
```

### Aggressive Pool (USDT/WVC)

```javascript
{
    loanTenor: 604800,         // 7 days
    maxLoanPerColl: 0.6,       // 60% LTV
    r1: 0.25,                  // 25% rate at low available liquidity (must exceed r2)
    r2: 0.05,                  // 5% minimum rate
    liquidityBnd1: 10000,      // 10k USDT
    liquidityBnd2: 50000,      // 50k USDT
    minLoan: 50,               // 50 USDT
    creatorFee: 0.01           // 1%
}
```

## Production Deploy Runbook

The canonical production deploy uses **`scripts/deploy.prod.ts`** (env-driven, no
mocks, no hardcoded escrow). The legacy `scripts/deploy.ts` is a LOCAL DEMO only
(it deploys MockERC20 tokens and runs an inline smoke test) — do not use it for
mainnet.

### Prerequisites

1. **Environment**: copy `.env.example` to `.env` and fill in:
   - `PRIVATE_KEY` — the funded deployer EOA (kept secret; `.env` is gitignored).
   - `VINUCHAIN_RPC_URL` — defaults to `https://rpc.vinuchain.org` if unset.
   - `LOAN_CCY_TOKEN`, `COLL_CCY_TOKEN`, `VOTE_TOKEN`, `VETO_HOLDER`,
     `EMERGENCY_ESCROW` — all required; the script aborts on any missing,
     zero, or placeholder address.
   - **Required economic params** (`MAX_LOAN_PER_COLL`, `LIQUIDITY_BND_1`,
     `LIQUIDITY_BND_2`, `MIN_LOAN`, `MIN_LIQUIDITY`) — these are
     loan-token-decimal-dependent and have **NO defaults**; the script aborts if
     any is unset (see the Decimals sanity check below).
   - Optional decimal-INDEPENDENT policy/governance params (`LOAN_TENOR`,
     `R1`/`R2`, `CREATOR_FEE`, `REWARD_COEFFICIENT`, `COLL_TOKEN_DECIMALS`, the
     four `*_THRESHOLD`s, `SNAPSHOT_TOKEN_EVERY`, `CONTROLLER_LOCK_PERIOD`) —
     production-safe defaults are baked in; override only deliberately.
2. **Decimals sanity check** (do this BEFORE filling in the economic params): the
   five required economic params are denominated in the LOAN TOKEN's raw base
   units, so each must be recomputed for the loan token's decimals. Confirm the
   loan token's `decimals()` on-chain, then derive each value, e.g.:
   ```
   MAX_LOAN_PER_COLL = price_in_loanCcy_per_whole_collateral * 10**loanCcyDecimals
   ```
   For the documented USDT(6) loan pool, "0.5 USDT lent per 1 WVC" =
   `0.5 * 10**6 = 500000`. Getting these wrong (e.g. an 18-decimal value against a
   6-decimal loan token) mis-collateralizes the pool — `BasePool.loanTerms`
   computes `loan ≈ pledge * maxLoanPerColl / 10**collTokenDecimals`, and
   `_maxLoanPerColl` is "denominated in loanCcy decimals"
   (`contracts/BasePool.sol:99`). The `.env.example` carries a worked USDT(6)
   example for all five.
3. **Funded deployer**: the deployer must hold at least `0.1 VC` (checked by the
   script before any transaction).
4. **Compile**: `npx hardhat compile` must succeed.

The script validates every address (`^0x[0-9a-fA-F]{40}$`, non-zero,
non-placeholder), requires the five decimal-dependent economic params (no
defaults), asserts `LOAN_CCY_TOKEN != COLL_CCY_TOKEN`, `R1 > R2 > 0`,
`LIQUIDITY_BND_2 > LIQUIDITY_BND_1 > 0`, `MAX_LOAN_PER_COLL > 0`,
`MIN_LIQUIDITY >= 1000`, each governance threshold in `(0, 10000]`, and that the
connected chain is `207` (VinuChain mainnet). It refuses to run on any other chain.

### Deploy Command

```bash
npx hardhat run scripts/deploy.prod.ts --network vinuchain
```

The script deploys, in order: **Controller -> BasePool -> MultiClaim ->
EmergencyWithdrawal**, writes `deployments/vinuchain.json` (addresses + params +
timestamp + deployer), and prints a summary and post-deploy checklist. It does
**not** mutate pool state (no whitelist proposal, no approvals, no smoke test) —
those are the manual steps below.

### Post-Deploy Steps

1. **Record** `deployments/vinuchain.json` (commit it, archive it, share addresses).
2. **Verify each contract** on the explorer:
   ```bash
   npx hardhat verify --network vinuchain <CONTROLLER_ADDR> <controller ctor args...>
   npx hardhat verify --network vinuchain --constructor-args arguments.js <POOL_ADDR>
   npx hardhat verify --network vinuchain <MULTICLAIM_ADDR>
   npx hardhat verify --network vinuchain <EMERGENCY_WITHDRAWAL_ADDR>
   ```
   (See "Contract Verification" above for the BasePool `arguments.js` format.)
3. **Update [vinuchain-lists](https://github.com/VinuChain/vinuchain-lists) and the
   frontend config** with the new contract addresses.
4. **Transfer the Controller veto holder to the multisig** if it was bootstrapped
   from an EOA (`VETO_HOLDER`).
5. **Governance bootstrap**: stake VINU in the Controller, create the whitelist
   proposal for the pool, vote, and have the veto holder approve it.
6. **Smoke test with small amounts**: `addLiquidity` -> `borrow` -> `repay` ->
   `claim`, then confirm balances and pool state.

## Post-Deployment Checklist

### Immediate Actions

- [ ] Verify all contracts on explorer
- [ ] Transfer veto holder to multisig
- [ ] Test addLiquidity with small amount
- [ ] Test borrow with small amount
- [ ] Verify interest rate calculation
- [ ] Test repay and claim

### Governance Setup

- [ ] Stake VINU tokens in Controller
- [ ] Create whitelist proposal for pool
- [ ] Vote on whitelist proposal
- [ ] Verify LP rewards after whitelist

### Frontend Integration

- [ ] Update contract addresses in frontend config
- [ ] Test all UI flows on mainnet
- [ ] Verify transaction signing
- [ ] Test wallet connections

## Monitoring

### Key Metrics

Monitor these on VinuChain:

1. **Pool Utilization**: totalLiquidity vs active loans
2. **Interest Rates**: Current rates vs boundaries
3. **Default Rate**: Percentage of loans not repaid
4. **TVL**: Total value locked across pools

### Event Monitoring

Set up event listeners:

```javascript
// Monitor new loans
pool.on("Borrow", (borrower, loanIdx, collateral, loanAmount, ...) => {
    console.log(`New loan: ${loanIdx} for ${loanAmount}`);
});

// Monitor liquidity changes
pool.on("AddLiquidity", (lp, amount, shares, ...) => {
    console.log(`LP ${lp} added ${amount}`);
});
```

## Emergency Procedures

### Pause Pool

```javascript
// Create PAUSE proposal
await controller.createProposal(
    poolAddress,
    0,  // PAUSE action
    Math.floor(Date.now() / 1000) + 86400
);

// Vote with majority
await controller.vote(proposalIdx);
```

### Emergency Contact

In case of critical issues:
1. Immediately pause affected pools
2. Document the issue
3. Communicate with users via official channels
4. Engage security researchers if needed

## Related

- [Deployment Overview](overview.md)
- [Creating Pools](creating-pools.md)
- [Governance Guide](../guides/governance.md)
