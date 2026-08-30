import { BigNumber } from "@ethersproject/bignumber"
import { time } from "@nomicfoundation/hardhat-network-helpers"
import chai from "chai"
import hre, { ethers } from "hardhat"

const { expect } = chai

const BASE = BigNumber.from("1000000000000000000")
const LOAN_DECIMALS = 6
const COLLATERAL_DECIMALS = 18
const LOAN_TENOR = 86400
const MAX_LOAN_PER_COLL = BigNumber.from("500000") // 0.5 loan units per collateral unit
const R1 = BASE.mul(15).div(100)
const R2 = BASE.mul(2).div(100)
const LIQUIDITY_BND_1 = BigNumber.from("10000000")
const LIQUIDITY_BND_2 = BigNumber.from("100000000")
const MIN_LOAN = BigNumber.from("100000")
const CREATOR_FEE = BASE.div(100)
const MIN_LIQUIDITY = BigNumber.from("1000000")
const REWARD_COEFFICIENT = BigNumber.from("1000000000000000")
const INITIAL_LIQUIDITY = BigNumber.from("40000000")
const COLLATERAL = ethers.utils.parseUnits("4", COLLATERAL_DECIMALS)

function expectBigNumber(actual: any, expected: BigNumber | string | number) {
    expect(actual.toString()).to.equal(BigNumber.from(expected).toString())
}

const POOL_CONSTRUCTOR_ARGS_ABI = [
    'address[]',
    'uint256',
    'uint256',
    'uint256',
    'uint256[]',
    'uint256[]',
    'uint256',
    'uint256',
    'uint256',
    'address',
    'uint96',
]

function encodePoolCreationParams(values: {
    tokens: string[]
    collTokenDecimals: number
    loanTenor: number
    maxLoanPerColl: BigNumber
    rs: BigNumber[]
    liquidityBnds: BigNumber[]
    minLoan: BigNumber
    creatorFee: BigNumber
    minLiquidity: BigNumber
    poolController: string
    rewardCoefficient: BigNumber
}) {
    return ethers.utils.defaultAbiCoder.encode(POOL_CONSTRUCTOR_ARGS_ABI, [
        values.tokens,
        values.collTokenDecimals,
        values.loanTenor,
        values.maxLoanPerColl,
        values.rs,
        values.liquidityBnds,
        values.minLoan,
        values.creatorFee,
        values.minLiquidity,
        values.poolController,
        values.rewardCoefficient,
    ])
}

describe("production deployment rehearsal", function () {
    it("deploys the production graph and completes a funded local lifecycle", async function () {
        const [deployer, manager, lp, borrower, escrow] = await ethers.getSigners()
        const deploymentBlocks: number[] = []

        async function assertDeployment(contract: any) {
            const receipt = await contract.deployTransaction.wait()
            expect(receipt.status).to.equal(1)
            expect(await ethers.provider.getCode(contract.address)).to.not.equal("0x")
            deploymentBlocks.push(receipt.blockNumber)
        }

        // Mock tokens stand in for already-deployed production tokens. The
        // protocol graph itself follows deploy.prod.ts exactly.
        const Token = await ethers.getContractFactory("MockDecimalsERC20")
        const loanToken = await Token.deploy(LOAN_DECIMALS)
        await loanToken.deployed()
        const collateralToken = await Token.deploy(COLLATERAL_DECIMALS)
        await collateralToken.deployed()
        const voteToken = await Token.deploy(COLLATERAL_DECIMALS)
        await voteToken.deployed()

        const Controller = await ethers.getContractFactory("Controller")
        const BasePool = await ethers.getContractFactory("BasePool")
        const controller = await Controller.deploy(
            voteToken.address,
            5000,
            5000,
            5000,
            5000,
            86400,
            0,
            deployer.address,
        )
        await controller.deployed()
        await assertDeployment(controller)

        // Keep this explicit and below EIP-7825's 2^24 cap. Production uses
        // ~5m gas; the larger ceiling also admits coverage instrumentation.
        const poolCreationTx = await controller.createPool(BasePool.bytecode, encodePoolCreationParams({
            tokens: [loanToken.address, collateralToken.address],
            collTokenDecimals: COLLATERAL_DECIMALS,
            loanTenor: LOAN_TENOR,
            maxLoanPerColl: MAX_LOAN_PER_COLL,
            rs: [R1, R2],
            liquidityBnds: [LIQUIDITY_BND_1, LIQUIDITY_BND_2],
            minLoan: MIN_LOAN,
            creatorFee: CREATOR_FEE,
            minLiquidity: MIN_LIQUIDITY,
            poolController: controller.address,
            rewardCoefficient: REWARD_COEFFICIENT,
        }), { gasLimit: 16_000_000 })
        const poolCreationReceipt = await poolCreationTx.wait()
        if (!("__SOLIDITY_COVERAGE_RUNNING" in hre)) {
            expect(poolCreationReceipt.gasUsed.lte(8_000_000)).to.equal(true)
        }
        const poolCreatedEvent = poolCreationReceipt.events?.find((event: any) => event.event === "PoolCreated")
        expect(poolCreationReceipt.status).to.equal(1)
        expect(poolCreatedEvent?.args?.pool).to.be.a("string")
        const pool = BasePool.attach(poolCreatedEvent!.args!.pool)
        expect(await ethers.provider.getCode(pool.address)).to.not.equal("0x")
        expect(await controller.basePoolCreationCodeHash()).to.equal(ethers.utils.keccak256(BasePool.bytecode))
        deploymentBlocks.push(poolCreationReceipt.blockNumber)

        const MultiClaim = await ethers.getContractFactory("MultiClaim")
        const multiClaim = await MultiClaim.deploy()
        await multiClaim.deployed()
        await assertDeployment(multiClaim)

        const EmergencyWithdrawal = await ethers.getContractFactory("EmergencyWithdrawal")
        const emergency = await EmergencyWithdrawal.deploy()
        await emergency.deployed()
        await assertDeployment(emergency)

        expect(deploymentBlocks).to.have.length(4)
        expect(deploymentBlocks[0]).to.be.lessThan(deploymentBlocks[1])
        expect(deploymentBlocks[1]).to.be.lessThan(deploymentBlocks[2])
        expect(deploymentBlocks[2]).to.be.lessThan(deploymentBlocks[3])
        const deployedAddresses = [controller.address, pool.address, multiClaim.address, emergency.address]
            .map((address) => address.toLowerCase())
        expect(new Set(deployedAddresses).size).to.equal(4)

        expect(await controller.voteToken()).to.equal(voteToken.address)
        expect(await controller.vetoHolder()).to.equal(deployer.address)
        expect(await pool.poolController()).to.equal(controller.address)
        expect(await controller.poolWhitelisted(pool.address)).to.equal(false)
        expect(await controller.poolRegistered(pool.address)).to.equal(true)

        const poolInfo = await pool.getPoolInfo()
        expect(poolInfo[0]).to.equal(loanToken.address)
        expect(poolInfo[1]).to.equal(collateralToken.address)
        expectBigNumber(poolInfo[2], MAX_LOAN_PER_COLL)
        expectBigNumber(poolInfo[3], MIN_LOAN)
        expectBigNumber(poolInfo[4], LOAN_TENOR)
        expectBigNumber(poolInfo[5], 0)
        expectBigNumber(poolInfo[6], 0)
        expectBigNumber(poolInfo[7], REWARD_COEFFICIENT)
        expectBigNumber(poolInfo[8], 1)

        // Fund governance, reward supply, LP principal, and borrower balances.
        const voteAmount = ethers.utils.parseUnits("1", 18)
        const rewardSupply = ethers.utils.parseUnits("100", 18)
        await voteToken.connect(manager).mint(voteAmount)
        await voteToken.mint(rewardSupply)
        await voteToken.connect(manager).approve(controller.address, voteAmount)
        await voteToken.connect(deployer).approve(controller.address, rewardSupply)
        await controller.connect(manager).depositVoteToken(voteAmount)
        await controller.connect(deployer).depositRewardSupply(rewardSupply)

        // A real whitelist proposal exercises controller validation against the
        // deployed BasePool runtime hash before any pool state mutation.
        const proposalDeadline = (await time.latest()) + 3600
        await controller.connect(manager).createProposal(pool.address, 2, proposalDeadline)
        const whitelistProposal = (await controller.numProposals()).sub(1)
        await controller.connect(manager).vote(whitelistProposal)
        await controller.connect(deployer).setVetoHolderApproval(whitelistProposal, true)
        expect(await controller.poolWhitelisted(pool.address)).to.equal(true)
        expect((await controller.getProposal(whitelistProposal))[4]).to.equal(true)

        await loanToken.connect(lp).mint(INITIAL_LIQUIDITY)
        await loanToken.connect(lp).approve(pool.address, INITIAL_LIQUIDITY)
        await collateralToken.connect(borrower).mint(COLLATERAL.mul(2))

        // Add liquidity, accrue a nonzero reward, and claim it through the
        // real Controller path rather than a reward mock.
        await pool.connect(lp).addLiquidity(
            lp.address,
            INITIAL_LIQUIDITY,
            (await time.latest()) + 3600,
            0,
        )
        expectBigNumber((await pool.getPoolInfo())[5], INITIAL_LIQUIDITY)
        const sharesAfterAdd = await pool.getCurrentLpShares(lp.address)
        expect(sharesAfterAdd.gt(0)).to.equal(true)
        const lpInfoAfterAdd = await pool.getLpInfo(lp.address)
        expectBigNumber(lpInfoAfterAdd[3][lpInfoAfterAdd[3].length - 1], sharesAfterAdd)

        await time.increase(3600)
        const rewardBefore = await controller.rewardBalance(lp.address)
        await pool.connect(lp).forceRewardUpdate(lp.address)
        const rewardAfter = await controller.rewardBalance(lp.address)
        expect(rewardAfter.gt(rewardBefore)).to.equal(true)
        const voteBalanceBeforeClaim = await voteToken.balanceOf(lp.address)
        await controller.connect(lp).collectReward(false)
        expectBigNumber(await voteToken.balanceOf(lp.address), voteBalanceBeforeClaim.add(rewardAfter))
        expectBigNumber(await controller.rewardBalance(lp.address), 0)

        // Self-borrow with the exact quote, repay, and claim the settled loan.
        const loanTerms = await pool.loanTerms(COLLATERAL)
        expect(loanTerms[0].gt(MIN_LOAN)).to.equal(true)
        await loanToken.connect(borrower).mint(loanTerms[1])
        await collateralToken.connect(borrower).approve(pool.address, COLLATERAL)
        const borrowerLoanBefore = await loanToken.balanceOf(borrower.address)
        const poolLoanBeforeBorrow = await loanToken.balanceOf(pool.address)
        const controllerCollateralBefore = await collateralToken.balanceOf(controller.address)
        await pool.connect(borrower).borrow(
            borrower.address,
            COLLATERAL,
            loanTerms[0],
            loanTerms[1],
            (await time.latest()) + 3600,
            0,
        )
        expectBigNumber(
            (await loanToken.balanceOf(borrower.address)).sub(borrowerLoanBefore),
            loanTerms[0],
        )
        expectBigNumber(
            poolLoanBeforeBorrow.sub(await loanToken.balanceOf(pool.address)),
            loanTerms[0],
        )
        expectBigNumber(
            (await collateralToken.balanceOf(controller.address)).sub(controllerCollateralBefore),
            loanTerms[3],
        )
        expect(await pool.loanIdxToBorrower(1)).to.equal(borrower.address)
        const loanInfo = await pool.loanIdxToLoanInfo(1)
        expectBigNumber(loanInfo.repayment, loanTerms[1])
        expectBigNumber(loanInfo.collateral, loanTerms[2])
        expectBigNumber(loanInfo.loanAmount, loanTerms[0])
        expect(loanInfo.repaid).to.equal(false)

        await loanToken.connect(borrower).approve(pool.address, loanTerms[1])
        const borrowerCollateralBeforeRepay = await collateralToken.balanceOf(borrower.address)
        const poolLoanBeforeRepay = await loanToken.balanceOf(pool.address)
        await pool.connect(borrower).repay(1, borrower.address)
        expectBigNumber(
            (await loanToken.balanceOf(pool.address)).sub(poolLoanBeforeRepay),
            loanTerms[1],
        )
        expectBigNumber(
            (await collateralToken.balanceOf(borrower.address)).sub(borrowerCollateralBeforeRepay),
            loanTerms[2],
        )
        expect((await pool.loanIdxToLoanInfo(1)).repaid).to.equal(true)

        const lpLoanBeforeClaim = await loanToken.balanceOf(lp.address)
        await pool.connect(lp).claim(lp.address, [1], false, (await time.latest()) + 3600)
        expectBigNumber(
            (await loanToken.balanceOf(lp.address)).sub(lpLoanBeforeClaim),
            loanTerms[1],
        )
        expectBigNumber(await pool.claimedLpShares(1), sharesAfterAdd)
        await expect(
            pool.connect(lp).claim(lp.address, [1], false, (await time.latest()) + 3600),
        ).to.be.revertedWith("Invalid claim range.")

        // Governance pause must stop normal entry while the emergency helper
        // remains able to redeem the LP's current share entitlement.
        async function executeGovernanceAction(action: number) {
            const proposal = await controller.numProposals()
            await controller.connect(manager).createProposal(
                pool.address,
                action,
                (await time.latest()) + 3600,
            )
            await controller.connect(manager).vote(proposal)
        }

        await executeGovernanceAction(0)
        expect(await pool.paused()).to.equal(true)
        await loanToken.connect(lp).mint(MIN_LIQUIDITY)
        await loanToken.connect(lp).approve(pool.address, MIN_LIQUIDITY)
        await expect(
            pool.connect(lp).addLiquidity(lp.address, MIN_LIQUIDITY, (await time.latest()) + 3600, 0),
        ).to.be.revertedWith("Pausable: paused")

        await pool.connect(lp).setApprovals(emergency.address, 4)
        await emergency.connect(lp).approve(pool.address, escrow.address)
        const liquidityBeforeEmergency = (await pool.getPoolInfo())[5]
        const lpSharesBeforeEmergency = await pool.getCurrentLpShares(lp.address)
        const lpLoanBeforeEmergency = await loanToken.balanceOf(lp.address)
        const escrowLoanBeforeEmergency = await loanToken.balanceOf(escrow.address)
        await emergency.connect(escrow).collectEmergency(pool.address, lp.address)
        const emergencyAmount = (await loanToken.balanceOf(lp.address)).sub(lpLoanBeforeEmergency)
        expect(emergencyAmount.gt(0)).to.equal(true)
        expect(emergencyAmount).to.equal(liquidityBeforeEmergency.sub(MIN_LIQUIDITY))
        expect(lpSharesBeforeEmergency.gt(0)).to.equal(true)
        expectBigNumber(await pool.getCurrentLpShares(lp.address), 0)
        expectBigNumber(await pool.getPoolInfo().then((info: any) => info[5]), MIN_LIQUIDITY)
        expectBigNumber(await loanToken.balanceOf(escrow.address), escrowLoanBeforeEmergency)
        expect(await emergency.isApproved(lp.address, pool.address, escrow.address)).to.equal(false)
        await expect(
            emergency.connect(escrow).collectEmergency(pool.address, lp.address),
        ).to.be.revertedWith("Not approved")

        await executeGovernanceAction(1)
        expect(await pool.paused()).to.equal(false)
        expect(await controller.poolWhitelisted(pool.address)).to.equal(true)
    })
})
