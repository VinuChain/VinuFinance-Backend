# Local Development

This guide explains how to set up a local development environment for VinuFinance.

## Prerequisites

- Node.js v20+ and Corepack/Yarn 1.22.22
- Git
- A code editor (VS Code recommended)

## Setup

### 1. Clone Repository

```bash
git clone https://github.com/VinuChain/VinuFinance-VinuChain.git
cd VinuFinance-VinuChain
```

### 2. Install Dependencies

```bash
corepack enable
yarn install --frozen-lockfile
```

`package.json#packageManager` pins Yarn 1.22.22. Keep the lockfile frozen in
local and CI installs so compiler and plugin versions cannot drift.

The Hardhat and Foundry compiler settings are intentionally identical:
**solc 0.8.36**, **EVM Cancun**, optimizer enabled with **200 runs**, and **Yul
enabled**, with the metadata bytecode hash disabled for deterministic output.
Run `yarn verify:compiler` to rebuild both artifacts and compare resolved
settings and exact init/runtime bytecode for all four deployed contracts.

Run the backend typecheck before tests:

```bash
yarn typecheck
```

The Foundry harness uses a pinned forge-std revision:

```bash
forge install --no-git foundry-rs/forge-std@rev=bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
yarn test:foundry
```

### 3. Environment Configuration

Create a `.env` file in the project root:

```bash
# Network RPC URLs
VINUCHAIN_RPC_URL=https://rpc.vinuchain.org
VINUCHAIN_TESTNET_RPC_URL=https://vinufoundation-rpc.com

# Private key for deployment (without 0x prefix)
PRIVATE_KEY=your_private_key_here

# VinuExplorer uses its public Blockscout-compatible API; no API key is needed.
```

The `vinuchain` Hardhat network is VinuChain mainnet (chain ID `207`). The
`vinuchainTestnet` network is the VinuChain testnet (chain ID `206`) and uses
`https://vinufoundation-rpc.com` by default. Its explorer is
`https://testnet.vinuexplorer.org`. Both networks omit deploy accounts unless
`PRIVATE_KEY` is set. `scripts/deploy.prod.ts` is deliberately mainnet-only;
use the local deployment rehearsal for a no-chain-mutation release check:

```bash
yarn test:deployment
yarn verify:network
```

## Project Structure

```
VinuFinance-VinuChain/
├── contracts/              # Solidity smart contracts
│   ├── BasePool.sol       # Core lending pool
│   ├── Controller.sol     # Governance contract
│   ├── MultiClaim.sol     # Batch claim helper
│   ├── EmergencyWithdrawal.sol
│   └── interfaces/        # Contract interfaces
├── scripts/               # Deployment scripts
├── test/                  # Test files
├── docs/                  # Documentation
├── hardhat.config.ts      # Hardhat configuration
└── package.json
```

## Compilation

Compile all contracts:

```bash
npx hardhat compile
```

Check for compilation errors:

```bash
npx hardhat compile --force
```

## Testing

### Run All Tests

```bash
npx hardhat test
```

### Run Specific Test File

```bash
npx hardhat test test/BasePool.test.js
```

### Run with Gas Reporting

```bash
REPORT_GAS=true npx hardhat test
```

### Run with Coverage

```bash
yarn coverage
yarn coverage:gate
```

`yarn coverage:gate` reads `coverage/coverage-final.json` and checks the
executable timestamp-test wrappers generated as `BasePool_parsed.sol` and
`Controller_parsed.sol`; the raw source entries are not substituted for those
wrappers. The gate requires at least 90% statement and line coverage for those
two core contracts, and at least 85% for `EmergencyWithdrawal` and `MultiClaim`.

Check the deterministic Foundry gas baseline with the same test selection used
in CI:

```bash
forge snapshot --check .gas-snapshot --match-path "test/foundry/*.t.sol"
```

## Local Blockchain

### Start Local Node

```bash
npx hardhat node
```

This starts a local Ethereum node at `http://127.0.0.1:8545`.

### Run Local Deployment Rehearsal

The release rehearsal uses an ephemeral Hardhat chain and never sends a
transaction to VinuChain:

```bash
yarn test:deployment
```

## Hardhat Console

Interactive console for testing:

```bash
npx hardhat console --network localhost
```

Example session:

```javascript
// Get deployed contracts
const BasePool = await ethers.getContractFactory("BasePool");
const Controller = await ethers.getContractFactory("Controller");

// Get signers
const [deployer, user1, user2] = await ethers.getSigners();

// Deploy test token
const TestToken = await ethers.getContractFactory("ERC20Mock");
const loanToken = await TestToken.deploy("USDT", "USDT", 6);
const collToken = await TestToken.deploy("WVC", "WVC", 18);

// Interact with contracts...
```

## Writing Tests

### Basic Test Structure

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BasePool", function () {
    let basePool;
    let loanToken, collToken;
    let owner, lp, borrower;

    beforeEach(async function () {
        [owner, lp, borrower] = await ethers.getSigners();

        // Deploy mock tokens
        const Token = await ethers.getContractFactory("ERC20Mock");
        loanToken = await Token.deploy("USDT", "USDT", 6);
        collToken = await Token.deploy("WVC", "WVC", 18);

        // Deploy pool...
    });

    describe("addLiquidity", function () {
        it("should mint LP shares", async function () {
            // Test implementation
        });

        it("should revert with zero amount", async function () {
            await expect(
                basePool.addLiquidity(lp.address, 0, deadline, 0)
            ).to.be.revertedWith("Invalid add amount.");
        });
    });
});
```

### Testing Time-Dependent Functions

```javascript
const { time } = require("@nomicfoundation/hardhat-network-helpers");

it("should allow removal after lock period", async function () {
    // Add liquidity
    await basePool.addLiquidity(lp.address, amount, deadline, 0);

    // Fast forward 120 seconds (MIN_LPING_PERIOD)
    await time.increase(120);

    // Now removal should work
    await basePool.removeLiquidity(lp.address, shares);
});
```

### Testing Events

```javascript
it("should emit AddLiquidity event", async function () {
    await expect(basePool.addLiquidity(lp.address, amount, deadline, 0))
        .to.emit(basePool, "AddLiquidity")
        .withArgs(
            lp.address,
            amount,
            expectedShares,
            expectedLiquidity,
            expectedTotalShares,
            expectedEarliestRemove,
            expectedLoanIdx,
            0
        );
});
```

## Deployment Scripts

### Basic Deployment

```javascript
// illustrative deployment sequence; use scripts/deploy.prod.ts for production
const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying with:", deployer.address);

    // Controller derives and stores the exact BasePool creation-code hash
    // internally; do not pass a hash constructor argument.
    const Controller = await ethers.getContractFactory("Controller");
    const controller = await Controller.deploy(
        voteTokenAddress,       // _voteToken
        5000,                   // _pauseThreshold (50% of 10000)
        5000,                   // _unpauseThreshold
        5000,                   // _whitelistThreshold
        5000,                   // _dewhitelistThreshold
        86400,                  // _snapshotEvery (1 day)
        604800,                 // _lockPeriod (7 days)
        vetoHolderAddress       // _vetoHolder
    );
    await controller.deployed();
    console.log("Controller:", controller.address);

    // Create BasePool through Controller (provenance is required for whitelist)
    const BasePool = await ethers.getContractFactory("BasePool");
    const encodedPool = ethers.utils.defaultAbiCoder.encode([
        "address[]", "uint256", "uint256", "uint256", "uint256[]", "uint256[]",
        "uint256", "uint256", "uint256", "address", "uint96",
    ], [[loanTokenAddress, collTokenAddress], 18, loanTenor, maxLoanPerColl,
        [r1, r2], [liquidityBnd1, liquidityBnd2], minLoan, creatorFee,
        minLiquidity, controller.address, rewardCoefficient
    ]);
    const poolTx = await controller.createPool(BasePool.bytecode, encodedPool, { gasLimit: 8_000_000 });
    const poolReceipt = await poolTx.wait();
    const poolEvent = poolReceipt.events.find((item) => item.event === "PoolCreated");
    if (!poolEvent) throw new Error("PoolCreated event missing");
    const pool = BasePool.attach(poolEvent.args.pool);
    console.log("BasePool:", pool.address);
}

main().catch(console.error);
```

`Controller.createPool` accepts only the exact `BasePool` creation code, checks
the deployed pool's Controller binding, and records the pool in
`poolRegistered` before governance can whitelist it.

### Running Deployment

```bash
# Ephemeral local production-equivalent rehearsal (mock tokens only)
yarn test:deployment

# Testnet network registration/read-only gate (does not deploy)
yarn verify:network

# Mainnet production deployment (requires the deploy.prod.ts env contract)
npx hardhat run scripts/deploy.prod.ts --network vinuchain
```

## Contract Verification

After a separately authorized deployment, verify on VinuExplorer's
Blockscout-compatible API. The Hardhat config registers both chain 207 and
testnet chain 206 with their documented API and browser URLs;
the command below submits a verification request, so run it only after
checking the deployment address and constructor arguments. First validate the
registration without making a submission:

```bash
yarn verify:network
```

Then, for each deployed contract:

```bash
npx hardhat verify --network vinuchain CONTRACT_ADDRESS constructor_args...
```

## Debugging

### Console Logs

Add console logs in Solidity (removed in production):

```solidity
import "hardhat/console.sol";

function borrow(...) external {
    console.log("Borrowing amount:", _sendAmount);
    console.log("Caller:", msg.sender);
    // ...
}
```

### Transaction Traces

```bash
npx hardhat test --trace
```

### Gas Profiling

```javascript
// In test file
const tx = await basePool.borrow(...);
const receipt = await tx.wait();
console.log("Gas used:", receipt.gasUsed.toString());
```

## Common Development Tasks

### Reset Local State

```bash
npx hardhat clean
npx hardhat compile --force
```

### Update Dependencies

```bash
yarn install --frozen-lockfile
```

### Check Contract Sizes

```bash
npx hardhat size-contracts
```

## IDE Setup

### VS Code Extensions

- Solidity (Juan Blanco)
- Hardhat for VS Code
- ESLint
- Prettier

### Settings

```json
{
    "solidity.compileUsingRemoteVersion": "v0.8.36",
    "editor.formatOnSave": true
}
```

## Troubleshooting

### "Contract size exceeds limit"

- Enable optimizer in hardhat.config.ts
- Split into smaller contracts
- Remove unnecessary code

### "Transaction reverted without reason"

- Add custom error messages
- Check all require conditions
- Use try/catch in tests to get error details

### "Nonce too high"

Reset account in MetaMask or restart local node.

### "Stack too deep"

- Use struct for variables
- Split function into smaller functions
- Enable via-ir compiler option

## Related

- [Deployment Overview](../deployment/overview.md)
- [Creating Pools](../deployment/creating-pools.md)
- [Security Considerations](../resources/security.md)
