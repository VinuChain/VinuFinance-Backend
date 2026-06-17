/**
 * Production deploy script for VinuFinance-Backend on VinuChain mainnet.
 *
 * Unlike scripts/deploy.ts (a DEMO that deploys MockERC20 tokens, funds test
 * signers, and runs an inline borrow/repay smoke test), this script:
 *   - reads ALL token/governance addresses and the deployer key from env vars
 *     (no mocks, no hardcoded escrow),
 *   - validates every address and parameter and aborts on anything missing,
 *     placeholder, or inconsistent,
 *   - targets VinuChain mainnet (chainId 207) and refuses any other chain,
 *   - deploys Controller -> BasePool -> MultiClaim -> EmergencyWithdrawal in that
 *     order, matching the real constructor signatures,
 *   - persists deployments/vinuchain.json and prints a post-deploy checklist.
 *
 * It deliberately does NOT mutate pool state (no whitelist proposal, no approvals,
 * no smoke test): deploy only. Governance bootstrap and verification are manual
 * post-deploy steps documented in docs/deployment/vinuchain.md.
 *
 * Run with:
 *   npx hardhat run scripts/deploy.prod.ts --network vinuchain
 *
 * Required env (see .env.example):
 *   PRIVATE_KEY, VINUCHAIN_RPC_URL (consumed by hardhat.config.ts)
 *   LOAN_CCY_TOKEN, COLL_CCY_TOKEN, VOTE_TOKEN, VETO_HOLDER, EMERGENCY_ESCROW
 * Optional pool/governance params have production-safe defaults below.
 */
import { BigNumber } from "@ethersproject/bignumber"
import * as fs from "fs"
import * as path from "path"
import hre from "hardhat"
import { ethers } from "hardhat"

// VinuChain mainnet chain id; this script refuses to run anywhere else.
const VINUCHAIN_CHAIN_ID = 207

// 10**18, used for BASE-denominated rate/fee/reward params.
const MONE = BigNumber.from("1000000000000000000")

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// --- env helpers ----------------------------------------------------------

function requireEnv(name: string): string {
    const v = process.env[name]
    if (v === undefined || v.trim() === "") {
        throw new Error(`Missing required env var: ${name}`)
    }
    return v.trim()
}

function requireAddress(name: string): string {
    const v = requireEnv(name)
    if (!ADDRESS_RE.test(v)) {
        throw new Error(`Env var ${name} is not a valid 0x address: "${v}"`)
    }
    if (v.toLowerCase() === ZERO_ADDRESS) {
        throw new Error(`Env var ${name} must not be the zero address`)
    }
    // Reject obvious placeholders that pass the regex by accident.
    if (/^0x0+1?$/i.test(v) || /^0x(dead|beef)/i.test(v)) {
        throw new Error(`Env var ${name} looks like a placeholder: "${v}"`)
    }
    return ethers.utils.getAddress(v) // checksum-normalize
}

function envOr(name: string, fallback: string): string {
    const v = process.env[name]
    return v === undefined || v.trim() === "" ? fallback : v.trim()
}

function envIntOr(name: string, fallback: number): number {
    const v = process.env[name]
    if (v === undefined || v.trim() === "") return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`Env var ${name} must be a non-negative integer: "${v}"`)
    }
    return n
}

// Read a BASE-denominated (1e18) value from env as a human decimal string
// (e.g. "0.05" -> 5e16). Falls back to `fallback` (already a base-unit string).
function envBaseOr(name: string, fallbackBaseUnits: string): string {
    const v = process.env[name]
    if (v === undefined || v.trim() === "") return fallbackBaseUnits
    return ethers.utils.parseUnits(v.trim(), 18).toString()
}

// --- main -----------------------------------------------------------------

async function main() {
    // ---- network guard ----
    const network = await ethers.provider.getNetwork()
    if (Number(network.chainId) !== VINUCHAIN_CHAIN_ID) {
        throw new Error(
            `Refusing to deploy: connected chainId is ${network.chainId}, expected ${VINUCHAIN_CHAIN_ID} (VinuChain mainnet). ` +
                `Run with --network vinuchain and a correct VINUCHAIN_RPC_URL.`
        )
    }

    const [deployer] = await ethers.getSigners()
    if (!deployer) {
        throw new Error("No deployer signer available. Set PRIVATE_KEY in the environment.")
    }

    // ---- required addresses (no mocks, no hardcoded escrow) ----
    const LOAN_CCY_TOKEN = requireAddress("LOAN_CCY_TOKEN")
    const COLL_CCY_TOKEN = requireAddress("COLL_CCY_TOKEN")
    const VOTE_TOKEN = requireAddress("VOTE_TOKEN")
    const VETO_HOLDER = requireAddress("VETO_HOLDER")
    const EMERGENCY_ESCROW = requireAddress("EMERGENCY_ESCROW")

    if (LOAN_CCY_TOKEN.toLowerCase() === COLL_CCY_TOKEN.toLowerCase()) {
        throw new Error("LOAN_CCY_TOKEN and COLL_CCY_TOKEN must differ (BasePool rejects equal tokens).")
    }

    // ---- pool params (production-safe defaults; override via env) ----
    // collateral token decimals (uint256) — defaults to 18 (WVC).
    const COLL_TOKEN_DECIMALS = envIntOr("COLL_TOKEN_DECIMALS", 18)
    // loan tenor in seconds; default 30 days. BasePool enforces >= MIN_TENOR (1 day).
    const LOAN_TENOR = envIntOr("LOAN_TENOR", 2592000)
    // maxLoanPerColl in loanCcy base units (raw string). Default 0.5 * 1e18.
    const MAX_LOAN_PER_COLL = envOr("MAX_LOAN_PER_COLL", MONE.mul(5).div(10).toString())
    // interest rate params, BASE-denominated. r1 must be > r2 (BasePool requires r1 > r2 > 0).
    const R1 = envBaseOr("R1", MONE.mul(15).div(100).toString()) // 15%
    const R2 = envBaseOr("R2", MONE.mul(2).div(100).toString()) // 2%
    // liquidity bounds in loanCcy base units (raw strings). bnd2 must be > bnd1 > 0.
    const LIQUIDITY_BND_1 = envOr("LIQUIDITY_BND_1", "10000000000") // 10k (6-dec USDT default)
    const LIQUIDITY_BND_2 = envOr("LIQUIDITY_BND_2", "100000000000") // 100k (6-dec USDT default)
    // minLoan in loanCcy base units (raw string). Default 100 (6-dec USDT).
    const MIN_LOAN = envOr("MIN_LOAN", "100000000")
    // creatorFee, BASE-denominated. BasePool caps at MAX_FEE (300bps = 0.03 * 1e18).
    const CREATOR_FEE = envBaseOr("CREATOR_FEE", MONE.mul(1).div(100).toString()) // 1%
    // minLiquidity in loanCcy base units (raw string). BasePool requires >= 1000.
    const MIN_LIQUIDITY = envOr("MIN_LIQUIDITY", "1000000000") // 1k (6-dec USDT)
    // rewardCoefficient, BASE-denominated (uint96). Default 1.0 * 1e18.
    const REWARD_COEFFICIENT = envBaseOr("REWARD_COEFFICIENT", MONE.toString())

    // ---- governance params for Controller (protocol constants; override via env) ----
    // Thresholds out of THRESHOLD_BASE (10000). Defaults mirror docs (50%).
    const PAUSE_THRESHOLD = envIntOr("PAUSE_THRESHOLD", 5000)
    const UNPAUSE_THRESHOLD = envIntOr("UNPAUSE_THRESHOLD", 5000)
    const WHITELIST_THRESHOLD = envIntOr("WHITELIST_THRESHOLD", 5000)
    const DEWHITELIST_THRESHOLD = envIntOr("DEWHITELIST_THRESHOLD", 5000)
    const SNAPSHOT_TOKEN_EVERY = envIntOr("SNAPSHOT_TOKEN_EVERY", 86400) // 1 day
    const CONTROLLER_LOCK_PERIOD = envIntOr("CONTROLLER_LOCK_PERIOD", 604800) // 7 days

    // ---- param sanity (fail fast before any tx) ----
    if (!BigNumber.from(R1).gt(BigNumber.from(R2))) {
        throw new Error(`R1 (${R1}) must be greater than R2 (${R2}).`)
    }
    if (BigNumber.from(R2).isZero()) {
        throw new Error("R2 must be greater than 0.")
    }
    if (!BigNumber.from(LIQUIDITY_BND_2).gt(BigNumber.from(LIQUIDITY_BND_1))) {
        throw new Error(`LIQUIDITY_BND_2 (${LIQUIDITY_BND_2}) must be greater than LIQUIDITY_BND_1 (${LIQUIDITY_BND_1}).`)
    }
    if (BigNumber.from(LIQUIDITY_BND_1).isZero()) {
        throw new Error("LIQUIDITY_BND_1 must be greater than 0.")
    }
    if (BigNumber.from(MAX_LOAN_PER_COLL).isZero()) {
        throw new Error("MAX_LOAN_PER_COLL must be greater than 0.")
    }
    if (BigNumber.from(MIN_LIQUIDITY).lt(BigNumber.from(1000))) {
        throw new Error("MIN_LIQUIDITY must be at least 1000 (BasePool requirement).")
    }
    for (const [n, v] of [
        ["PAUSE_THRESHOLD", PAUSE_THRESHOLD],
        ["UNPAUSE_THRESHOLD", UNPAUSE_THRESHOLD],
        ["WHITELIST_THRESHOLD", WHITELIST_THRESHOLD],
        ["DEWHITELIST_THRESHOLD", DEWHITELIST_THRESHOLD],
    ] as Array<[string, number]>) {
        if (v <= 0 || v > 10000) {
            throw new Error(`${n} must be in (0, 10000]; got ${v}.`)
        }
    }
    if (SNAPSHOT_TOKEN_EVERY <= 0) {
        throw new Error("SNAPSHOT_TOKEN_EVERY must be greater than 0.")
    }

    // ---- deployer balance check ----
    const balance = await deployer.getBalance()
    const minBalance = ethers.utils.parseEther("0.1")
    if (balance.lt(minBalance)) {
        throw new Error(
            `Deployer ${deployer.address} balance ${ethers.utils.formatEther(balance)} VC is below the 0.1 VC minimum.`
        )
    }

    console.log("=== VinuFinance production deploy (VinuChain mainnet) ===")
    console.log("Network chainId:", Number(network.chainId))
    console.log("Deployer:", deployer.address)
    console.log("Deployer balance:", ethers.utils.formatEther(balance), "VC")
    console.log("Loan token:", LOAN_CCY_TOKEN)
    console.log("Collateral token:", COLL_CCY_TOKEN)
    console.log("Vote token:", VOTE_TOKEN)
    console.log("Veto holder:", VETO_HOLDER)
    console.log("Emergency escrow:", EMERGENCY_ESCROW)
    console.log("")

    // ---- 1. Controller ----
    console.log("1. Deploying Controller...")
    const Controller = await hre.ethers.getContractFactory("Controller")
    const controller = await Controller.deploy(
        VOTE_TOKEN, // _voteToken
        PAUSE_THRESHOLD, // _pauseThreshold
        UNPAUSE_THRESHOLD, // _unpauseThreshold
        WHITELIST_THRESHOLD, // _whitelistThreshold
        DEWHITELIST_THRESHOLD, // _dewhitelistThreshold
        SNAPSHOT_TOKEN_EVERY, // _snapshotEvery
        CONTROLLER_LOCK_PERIOD, // _lockPeriod
        VETO_HOLDER // _vetoHolder
    )
    await controller.deployed()
    console.log("   Controller:", controller.address)

    // ---- 2. BasePool ----
    console.log("2. Deploying BasePool...")
    const BasePool = await hre.ethers.getContractFactory("BasePool")
    const pool = await BasePool.deploy(
        [LOAN_CCY_TOKEN, COLL_CCY_TOKEN], // _tokens [loanCcy, collCcy]
        COLL_TOKEN_DECIMALS, // _collTokenDecimals
        LOAN_TENOR, // _loanTenor
        MAX_LOAN_PER_COLL, // _maxLoanPerColl
        [R1, R2], // _rs [r1, r2]
        [LIQUIDITY_BND_1, LIQUIDITY_BND_2], // _liquidityBnds [bnd1, bnd2]
        MIN_LOAN, // _minLoan
        CREATOR_FEE, // _creatorFee
        MIN_LIQUIDITY, // _minLiquidity
        controller.address, // _poolController
        REWARD_COEFFICIENT // _rewardCoefficient
    )
    await pool.deployed()
    console.log("   BasePool:", pool.address)

    // ---- 3. MultiClaim (no constructor args) ----
    console.log("3. Deploying MultiClaim...")
    const MultiClaim = await hre.ethers.getContractFactory("MultiClaim")
    const multiClaim = await MultiClaim.deploy()
    await multiClaim.deployed()
    console.log("   MultiClaim:", multiClaim.address)

    // ---- 4. EmergencyWithdrawal (no constructor args) ----
    console.log("4. Deploying EmergencyWithdrawal...")
    const EmergencyWithdrawal = await hre.ethers.getContractFactory("EmergencyWithdrawal")
    const emergencyWithdrawal = await EmergencyWithdrawal.deploy()
    await emergencyWithdrawal.deployed()
    console.log("   EmergencyWithdrawal:", emergencyWithdrawal.address)

    // ---- persist deployment record ----
    const record = {
        network: "vinuchain",
        chainId: VINUCHAIN_CHAIN_ID,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        contracts: {
            Controller: controller.address,
            BasePool: pool.address,
            MultiClaim: multiClaim.address,
            EmergencyWithdrawal: emergencyWithdrawal.address,
        },
        params: {
            loanCcyToken: LOAN_CCY_TOKEN,
            collCcyToken: COLL_CCY_TOKEN,
            voteToken: VOTE_TOKEN,
            vetoHolder: VETO_HOLDER,
            emergencyEscrow: EMERGENCY_ESCROW,
            collTokenDecimals: COLL_TOKEN_DECIMALS,
            loanTenor: LOAN_TENOR,
            maxLoanPerColl: MAX_LOAN_PER_COLL,
            r1: R1,
            r2: R2,
            liquidityBnd1: LIQUIDITY_BND_1,
            liquidityBnd2: LIQUIDITY_BND_2,
            minLoan: MIN_LOAN,
            creatorFee: CREATOR_FEE,
            minLiquidity: MIN_LIQUIDITY,
            rewardCoefficient: REWARD_COEFFICIENT,
            pauseThreshold: PAUSE_THRESHOLD,
            unpauseThreshold: UNPAUSE_THRESHOLD,
            whitelistThreshold: WHITELIST_THRESHOLD,
            dewhitelistThreshold: DEWHITELIST_THRESHOLD,
            snapshotTokenEvery: SNAPSHOT_TOKEN_EVERY,
            controllerLockPeriod: CONTROLLER_LOCK_PERIOD,
        },
    }

    const outDir = path.join(__dirname, "..", "deployments")
    fs.mkdirSync(outDir, { recursive: true })
    const outFile = path.join(outDir, "vinuchain.json")
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2))

    console.log("")
    console.log("=== DEPLOYMENT SUMMARY ===")
    console.log("Controller:          ", controller.address)
    console.log("BasePool:            ", pool.address)
    console.log("MultiClaim:          ", multiClaim.address)
    console.log("EmergencyWithdrawal: ", emergencyWithdrawal.address)
    console.log("Saved to:            ", outFile)
    console.log("")
    console.log("=== POST-DEPLOY CHECKLIST (manual) ===")
    console.log("[ ] Commit/record deployments/vinuchain.json")
    console.log("[ ] Verify each contract: npx hardhat verify --network vinuchain <addr> <args>")
    console.log("[ ] Update vinuchain-lists + frontend config with the new addresses")
    console.log(`[ ] Transfer Controller veto holder to the multisig (currently ${VETO_HOLDER})`)
    console.log("[ ] Governance bootstrap: stake VINU, create + vote whitelist proposal, veto-approve")
    console.log("[ ] Smoke test with small amounts: addLiquidity -> borrow -> repay -> claim")
    console.log(`[ ] Wire EmergencyWithdrawal escrow approvals (escrow ${EMERGENCY_ESCROW})`)
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error)
        process.exit(1)
    })
