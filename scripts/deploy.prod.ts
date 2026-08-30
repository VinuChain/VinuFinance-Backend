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

// Read a REQUIRED raw integer (base-units) BigNumber from env. NO default:
// throws if unset. Used for the loanCcy-decimal-dependent economic params, where
// a baked default is unsafe (see the required-params comment block below).
function requireBigNumber(name: string): string {
    const v = requireEnv(name)
    let bn: BigNumber
    try {
        bn = BigNumber.from(v)
    } catch (e) {
        throw new Error(`Env var ${name} must be a raw integer in loanCcy base units: "${v}"`)
    }
    if (bn.isNegative()) {
        throw new Error(`Env var ${name} must not be negative: "${v}"`)
    }
    return bn.toString()
}

// Assert an address has deployed bytecode on the connected network (rejects EOAs
// and wrong/undeployed addresses). Read-only (eth_getCode), no transaction.
async function assertIsContract(label: string, addr: string): Promise<void> {
    let code: string
    try {
        code = await ethers.provider.getCode(addr)
    } catch (e: any) {
        throw new Error(`Failed to read code for ${label} ${addr}: ${e?.message || e}.`)
    }
    if (code === undefined || code === null || code === "0x" || code === "0x0") {
        throw new Error(`${label} ${addr} has no contract code on this network (EOA or undeployed).`)
    }
}

// Read and sanity-check an ERC20 token's decimals() on-chain (read-only, no tx).
// Returns the integer decimals; throws if the read fails or is out of [0, 30].
async function readTokenDecimals(label: string, addr: string): Promise<number> {
    let d: number
    try {
        const token = new ethers.Contract(addr, ["function decimals() view returns (uint8)"], ethers.provider)
        d = Number(await token.decimals())
    } catch (e: any) {
        throw new Error(
            `Failed to read decimals() from ${label} ${addr}: ${e?.message || e}. ` +
                `Verify ${label} is a deployed ERC20 on this network.`
        )
    }
    if (!Number.isInteger(d) || d < 0 || d > 30) {
        throw new Error(`${label} decimals from-chain (${d}) is out of the sane [0, 30] range.`)
    }
    return d
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

    // Collateral token decimals are NOT read as a defaulted policy param: they are
    // QUERIED on-chain from the collateral token in the pre-flight block (they feed
    // BasePool.loanTerms' `10 ** collTokenDecimals` scaling, BasePool.sol:654, so a
    // wrong guess mis-collateralizes the pool). An optional COLL_TOKEN_DECIMALS env
    // var, if set, is asserted to EQUAL the on-chain value (catches a wrong override);
    // undefined means "trust on-chain".
    const COLL_TOKEN_DECIMALS_OVERRIDE =
        process.env.COLL_TOKEN_DECIMALS === undefined || process.env.COLL_TOKEN_DECIMALS.trim() === ""
            ? undefined
            : envIntOr("COLL_TOKEN_DECIMALS", 0)

    // ---- decimal-INDEPENDENT policy params (safe production defaults; override via env) ----
    // These are pure policy: a duration, BASE=1e18 rate/fee fractions, and a reward
    // coefficient. They do NOT depend on the loan token's decimals, so a baked
    // default is safe.
    // loan tenor in seconds; default 30 days. BasePool enforces >= MIN_TENOR (1 day).
    const LOAN_TENOR = envIntOr("LOAN_TENOR", 2592000)
    // interest rate params, BASE-denominated. r1 must be > r2 (BasePool requires r1 > r2 > 0).
    const R1 = envBaseOr("R1", MONE.mul(15).div(100).toString()) // 15%
    const R2 = envBaseOr("R2", MONE.mul(2).div(100).toString()) // 2%
    // creatorFee, BASE-denominated. BasePool caps at MAX_FEE (300bps = 0.03 * 1e18).
    const CREATOR_FEE = envBaseOr("CREATOR_FEE", MONE.mul(1).div(100).toString()) // 1%
    // rewardCoefficient, BASE-denominated (uint96). Default 1.0 * 1e18.
    const REWARD_COEFFICIENT = envBaseOr("REWARD_COEFFICIENT", MONE.toString())

    // ---- decimal-DEPENDENT economic params (REQUIRED, NO defaults) ----
    // CRITICAL: every value below is denominated in the LOAN TOKEN's raw base units
    // (loanCcy decimals), so its correct magnitude depends entirely on which loan
    // token this pool uses. BasePool's docstring (contracts/BasePool.sol:99) states
    // `_maxLoanPerColl` is "denominated in loanCcy decimals", and `loanTerms`
    // (contracts/BasePool.sol ~:643-649) computes the disbursed loan as roughly
    //   loan ≈ pledge * maxLoanPerColl / 10**collTokenDecimals
    // A baked default that assumes the wrong loan-token decimals MIS-COLLATERALIZES
    // the pool: e.g. a default MAX_LOAN_PER_COLL of 5e17 against a 6-decimal USDT
    // loan token (the documented USDT(6)/WVC(18) pool) would let ~1 WVC of
    // collateral borrow ~5e17 raw USDT — practically the entire pool — leaving it
    // instantly undercollateralized. There is no safe universal default, so these
    // are REQUIRED env vars; the deploy aborts if any is unset. Provide each as a
    // raw integer already scaled to the loan token's decimals (see .env.example for
    // the USDT(6) worked example).
    // maxLoanPerColl: raw loanCcy units lent per ONE WHOLE collateral token.
    const MAX_LOAN_PER_COLL = requireBigNumber("MAX_LOAN_PER_COLL")
    // liquidity bounds in raw loanCcy units. bnd2 must be > bnd1 > 0.
    const LIQUIDITY_BND_1 = requireBigNumber("LIQUIDITY_BND_1")
    const LIQUIDITY_BND_2 = requireBigNumber("LIQUIDITY_BND_2")
    // minLoan in raw loanCcy units.
    const MIN_LOAN = requireBigNumber("MIN_LOAN")
    // minLiquidity in raw loanCcy units. BasePool requires >= 1000.
    const MIN_LIQUIDITY = requireBigNumber("MIN_LIQUIDITY")

    // ---- governance params for Controller (protocol constants; override via env) ----
    // Thresholds out of THRESHOLD_BASE (10000). Defaults mirror docs (50%).
    const PAUSE_THRESHOLD = envIntOr("PAUSE_THRESHOLD", 5000)
    const UNPAUSE_THRESHOLD = envIntOr("UNPAUSE_THRESHOLD", 5000)
    const WHITELIST_THRESHOLD = envIntOr("WHITELIST_THRESHOLD", 5000)
    const DEWHITELIST_THRESHOLD = envIntOr("DEWHITELIST_THRESHOLD", 5000)
    const SNAPSHOT_TOKEN_EVERY = envIntOr("SNAPSHOT_TOKEN_EVERY", 86400) // 1 day
    const CONTROLLER_LOCK_PERIOD = envIntOr("CONTROLLER_LOCK_PERIOD", 604800) // 7 days

    // ---- PRE-FLIGHT validation (fail fast: NO on-chain tx until everything is valid) ----
    // This single block runs BEFORE the first `.deploy()` so a bad param can never
    // leave an orphan Controller on-chain. Each check mirrors the REAL constructor
    // `require`s read from the contracts (cited inline), so a value that passes here
    // will also pass the constructor.

    // -- BasePool constructor requires (contracts/BasePool.sol:121-137) --
    // _tokens[0] != _tokens[1] (BasePool.sol:127) — addresses must differ.
    if (LOAN_CCY_TOKEN.toLowerCase() === COLL_CCY_TOKEN.toLowerCase()) {
        throw new Error("LOAN_CCY_TOKEN and COLL_CCY_TOKEN must differ (BasePool.sol:127).")
    }
    // _loanTenor >= MIN_TENOR (86400) (BasePool.sol:19,130).
    if (LOAN_TENOR < 86400) {
        throw new Error(`LOAN_TENOR (${LOAN_TENOR}) must be >= 86400 (MIN_TENOR; BasePool.sol:130).`)
    }
    // _maxLoanPerColl > 0 (BasePool.sol:131).
    if (BigNumber.from(MAX_LOAN_PER_COLL).lte(0)) {
        throw new Error(`MAX_LOAN_PER_COLL (${MAX_LOAN_PER_COLL}) must be > 0 (BasePool.sol:131).`)
    }
    // _rs[0] > _rs[1] && _rs[1] != 0 (BasePool.sol:132: reverts if r1 <= r2 || r2 == 0).
    if (BigNumber.from(R2).lte(0)) {
        throw new Error(`R2 (${R2}) must be > 0 (BasePool.sol:132).`)
    }
    if (!BigNumber.from(R1).gt(BigNumber.from(R2))) {
        throw new Error(`R1 (${R1}) must be > R2 (${R2}) (BasePool.sol:132).`)
    }
    // _liquidityBnds[1] > _liquidityBnds[0] && _liquidityBnds[0] != 0 (BasePool.sol:133-134).
    if (BigNumber.from(LIQUIDITY_BND_1).lte(0)) {
        throw new Error(`LIQUIDITY_BND_1 (${LIQUIDITY_BND_1}) must be > 0 (BasePool.sol:133-134).`)
    }
    if (!BigNumber.from(LIQUIDITY_BND_2).gt(BigNumber.from(LIQUIDITY_BND_1))) {
        throw new Error(
            `LIQUIDITY_BND_2 (${LIQUIDITY_BND_2}) must be > LIQUIDITY_BND_1 (${LIQUIDITY_BND_1}) (BasePool.sol:133-134).`
        )
    }
    // _minLiquidity >= 1000 (BasePool.sol:136).
    if (BigNumber.from(MIN_LIQUIDITY).lt(1000)) {
        throw new Error(`MIN_LIQUIDITY (${MIN_LIQUIDITY}) must be >= 1000 (BasePool.sol:136).`)
    }
    // _minLoan > 0. The constructor does NOT validate minLoan, but minLoan == 0 BRICKS
    // the (immutable) pool: _addLiquidity requires `totalLpShares < minLoan * BASE`
    // (BasePool.sol:867), which with minLoan == 0 is `totalLpShares < 0` — always
    // false — so every nonzero liquidity add reverts "Cannot add liquidity." forever.
    if (BigNumber.from(MIN_LOAN).lte(0)) {
        throw new Error(
            `MIN_LOAN (${MIN_LOAN}) must be > 0: minLoan == 0 bricks the pool ` +
                `(_addLiquidity requires totalLpShares < minLoan * BASE; BasePool.sol:867).`
        )
    }
    // _creatorFee in [0, MAX_FEE]. MAX_FEE = 300*10**14 = 3e16 = 0.03 * 1e18
    // (BasePool.sol:23,137). envBaseOr uses parseUnits, which ACCEPTS a negative human
    // decimal ("-0.01" -> negative base value), so the >= 0 floor is enforced here.
    if (BigNumber.from(CREATOR_FEE).lt(0)) {
        throw new Error(`CREATOR_FEE (${CREATOR_FEE}) must be >= 0.`)
    }
    if (BigNumber.from(CREATOR_FEE).gt(BigNumber.from("30000000000000000"))) {
        throw new Error(`CREATOR_FEE (${CREATOR_FEE}) must be <= 3e16 (MAX_FEE = 300bps; BasePool.sol:137).`)
    }
    // R1/R2 are also parsed via envBaseOr (parseUnits accepts negatives). The R2 > 0
    // and R1 > R2 checks above already exclude any negative rate, so no extra floor
    // is needed for them.

    // -- Controller constructor requires (contracts/Controller.sol:106-110) --
    // Thresholds in (0, THRESHOLD_BASE=10000]; snapshotEvery > 0.
    for (const [n, v] of [
        ["PAUSE_THRESHOLD", PAUSE_THRESHOLD],
        ["UNPAUSE_THRESHOLD", UNPAUSE_THRESHOLD],
        ["WHITELIST_THRESHOLD", WHITELIST_THRESHOLD],
        ["DEWHITELIST_THRESHOLD", DEWHITELIST_THRESHOLD],
    ] as Array<[string, number]>) {
        if (v <= 0 || v > 10000) {
            throw new Error(`${n} must be in (0, 10000] (Controller.sol:106-109); got ${v}.`)
        }
    }
    if (SNAPSHOT_TOKEN_EVERY <= 0) {
        throw new Error("SNAPSHOT_TOKEN_EVERY must be > 0 (Controller.sol:110).")
    }
    // _lockPeriod has no constructor bound (0 is allowed = no lock); envIntOr already
    // rejects negatives/non-integers, but assert >= 0 explicitly for the sweep.
    if (CONTROLLER_LOCK_PERIOD < 0) {
        throw new Error(`CONTROLLER_LOCK_PERIOD (${CONTROLLER_LOCK_PERIOD}) must be >= 0.`)
    }

    // -- REWARD_COEFFICIENT must fit BasePool's `uint96 _rewardCoefficient` --
    // (BasePool.sol:119). A value > 2^96-1 would overflow the constructor arg and
    // make the BasePool deploy revert AFTER the Controller is already on-chain
    // (orphan). Range-check it here, before any tx.
    const MAX_UINT96 = BigNumber.from(2).pow(96).sub(1) // 79228162514264337593543950335
    if (BigNumber.from(REWARD_COEFFICIENT).lt(0) || BigNumber.from(REWARD_COEFFICIENT).gt(MAX_UINT96)) {
        throw new Error(
            `REWARD_COEFFICIENT (${REWARD_COEFFICIENT}) must be in [0, 2^96-1] (${MAX_UINT96.toString()}) ` +
                `to fit BasePool's uint96 _rewardCoefficient (BasePool.sol:119).`
        )
    }

    // -- ON-CHAIN token validation (read-only, NO tx; before any deploy) --
    // All three token addresses passed requireAddress (regex + nonzero + anti-
    // placeholder) above. Here we additionally probe them ON-CHAIN so a wrong or EOA
    // address fails pre-flight rather than after the Controller is deployed (orphan):
    //   - all 3 must have contract code (getCode != 0x);
    //   - LOAN_CCY_TOKEN & COLL_CCY_TOKEN must expose decimals() (they ARE ERC20s and
    //     their decimals feed the economic params / loanTerms scaling);
    //   - VOTE_TOKEN is the Controller's IERC20 voteToken — we verify it's a contract
    //     and (cheaply) that it answers totalSupply(), without assuming its decimals.
    await assertIsContract("LOAN_CCY_TOKEN", LOAN_CCY_TOKEN)
    await assertIsContract("COLL_CCY_TOKEN", COLL_CCY_TOKEN)
    await assertIsContract("VOTE_TOKEN", VOTE_TOKEN)

    // Loan token must be a readable ERC20 (decimals()). The value is informational
    // here — the loan-denominated econ params are operator-provided raw units — but a
    // failed read means LOAN_CCY_TOKEN is not the ERC20 the operator thinks it is.
    const LOAN_TOKEN_DECIMALS = await readTokenDecimals("LOAN_CCY_TOKEN", LOAN_CCY_TOKEN)

    // Collateral decimals: QUERY on-chain and USE as the BasePool _collTokenDecimals
    // arg. BasePool.loanTerms scales by `10 ** collTokenDecimals` (BasePool.sol:654),
    // so a wrong value mis-collateralizes the pool for any non-18-decimal collateral.
    const COLL_TOKEN_DECIMALS = await readTokenDecimals("COLL_CCY_TOKEN", COLL_CCY_TOKEN)
    // If the operator set the optional COLL_TOKEN_DECIMALS override, assert it matches
    // the on-chain value (catches a wrong override before any deploy).
    if (COLL_TOKEN_DECIMALS_OVERRIDE !== undefined && COLL_TOKEN_DECIMALS_OVERRIDE !== COLL_TOKEN_DECIMALS) {
        throw new Error(
            `COLL_TOKEN_DECIMALS override (${COLL_TOKEN_DECIMALS_OVERRIDE}) does not match the collateral ` +
                `token's on-chain decimals (${COLL_TOKEN_DECIMALS}). Remove the override or fix it.`
        )
    }

    // Vote token: confirm it answers a basic ERC20 view (totalSupply) so a non-token
    // contract address is caught. Cheap, read-only; result is informational.
    try {
        const voteToken = new ethers.Contract(
            VOTE_TOKEN,
            ["function totalSupply() view returns (uint256)"],
            ethers.provider
        )
        await voteToken.totalSupply()
    } catch (e: any) {
        throw new Error(
            `VOTE_TOKEN ${VOTE_TOKEN} did not answer totalSupply(): ${e?.message || e}. ` +
                `Verify it is the governance ERC20.`
        )
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
            loanTokenDecimals: LOAN_TOKEN_DECIMALS,
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
    console.log("[ ] Submit exact deployment-era standard JSON source + constructor args to the explorer")
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
