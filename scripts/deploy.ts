import { BigNumber } from "@ethersproject/bignumber"
import hre from 'hardhat'
import { ethers } from "hardhat"
import { expect } from "chai"
import { isNumberObject } from "util/types"


const MONE = BigNumber.from('1000000000000000000') //10**18
const ONE_LOAN_TOKEN = MONE
const ONE_COLL_TOKEN = MONE
const ONE_VOTE_TOKEN = MONE
const LOAN_TENOR = 86400
const MAX_LOAN_PER_COLL = ONE_LOAN_TOKEN.mul(15).div(10).toString()
const R1 = MONE.mul(5).div(100).toString()
const R2 = MONE.mul(2).div(100).toString()
const LIQUIDITY_BND_1 = ONE_LOAN_TOKEN.mul(10).toString()
const LIQUIDITY_BND_2 = ONE_LOAN_TOKEN.mul(100).toString()
const MIN_LOAN = ONE_LOAN_TOKEN.mul(20).div(100).toString() // 0.20 VINU
const DECIMALS = 18 //18
const MIN_LIQUIDITY = ONE_LOAN_TOKEN.mul(1).toString()
const MIN_LPING_PERIOD = 120
const EMERGENCY_ESCROW = '0x90e839B02e0285bf3dC52FaeB96a967352e4f2f4'

const CREATOR_FEE = MONE.mul(15).div(1000).toString() // 1.5%
const SNAPSHOT_TOKEN_EVERY = 100 
const PAUSE_THRESHOLD = 2000 // 20%
const UNPAUSE_THRESHOLD = 3000 // 30%
const WHITELIST_THRESHOLD = 6000 // 60%
const DEWHITELIST_THRESHOLD = 4000 // 40%
const CONTROLLER_LOCK_PERIOD = 10
const REWARD_COEFFICIENT = MONE.div(1000).toString()
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

var LOAN_CCY_TOKEN = 'INVALID_ADDRESS'
var COLL_CCY_TOKEN = 'INVALID_ADDRESS'
var VOTE_TOKEN = 'INVALID_ADDRESS'

const Actions = {
    Pause : 0,
    Unpause : 1,
    Whitelist : 2,
    Dewhitelist : 3
}

var deployer : any = null
var alice : any = null
var bob : any = null
var charlie : any = null
var loanCcyTokenContract : any = null
var collCcyTokenContract : any = null
var voteTokenContract : any = null

var controllerContract : any = null
var contract : any = null
var multiclaimContract : any = null

function getTimestamp() {
    return Math.round(Date.now() / 1000);
}

const approvalBits = (permissions : Array<string>) => {
    let bits = 0
    const possiblePermissions = ['repay', 'addLiquidity', 'removeLiquidity', 'claim', 'forceRewardUpdate']

    for (const permission of permissions) {
        if (!possiblePermissions.includes(permission)) {
            throw new Error('Unsupported permission.')
        }
    }

    for (let i = 0; i < possiblePermissions.length; i++) {
        if (permissions.includes(possiblePermissions[i])) {
            bits += 2 ** i
        }
    }
    return bits
}

const checkEvents = async (tx, correct : Array<Object>, referenceContract : any | undefined = undefined) => {
    if (!referenceContract) {
        referenceContract = contract
    }
    const receipt = await tx.wait()

    let i = 0
    for (const event of receipt.events) {
        if (event.address == referenceContract.address) {
            // console.log(Object.entries(event))
            // console.log(`Event ${event.event} with args ${event.args}`)

            const result = event.args
            
            const correctItem = {}
            const parsedResult = {}
            for (const key of Object.keys(correct[i])) {
                if (!isNumberObject(key)) {
                    correctItem[key] = String(correct[i][key])
                    parsedResult[key] = String(result[key])

                }
            }
            expect(parsedResult).to.be.deep.equal(correctItem)

            i++
        }
    }
}

const checkQuery = async (methodName : string, params : Array<any>, expected : Array<any>, referenceContract : ethers.Contract | undefined = undefined) => {
    if (!referenceContract) {
        referenceContract = contract
    }

    const serialize = x => {
        if (Array.isArray(x)) {
            return x.map(y => serialize(y))
        }
        if (typeof x == 'boolean') {
            return x
        }

        if (x instanceof BigNumber) {
            return x.toString()
        }

        return String(x)
    }
    let parsedExpected = serialize(expected) //expected.map(x => String(x))

    if (parsedExpected.length == 1) {
        parsedExpected = parsedExpected[0]
    }

    let actual = await referenceContract[methodName](...params)

    actual = serialize(actual)

    expect(await referenceContract[methodName](...params)).to.be.deep.equal(parsedExpected)
}

async function setup() {
    console.log('Creating signer...')
    const [d, a, b, c] = await ethers.getSigners();
    [deployer, alice, bob, charlie] = [d, a, b, c]

    const erc20Blueprint = await hre.ethers.getContractFactory('MockERC20')

    console.log('Deploying mock tokens...')
    loanCcyTokenContract = await erc20Blueprint.deploy()
    LOAN_CCY_TOKEN = loanCcyTokenContract.address
    console.log('Loan token deployed to:', LOAN_CCY_TOKEN)


    collCcyTokenContract = await erc20Blueprint.deploy()
    COLL_CCY_TOKEN = collCcyTokenContract.address
    console.log('Collateral token deployed to:', COLL_CCY_TOKEN)

    voteTokenContract = await erc20Blueprint.deploy()
    VOTE_TOKEN = voteTokenContract.address
    console.log('Vote token deployed to:', VOTE_TOKEN)

    console.log('Minting tokens...')
    await loanCcyTokenContract.connect(deployer).mint(ONE_LOAN_TOKEN.mul(10000).toString())
    await collCcyTokenContract.connect(deployer).mint(ONE_COLL_TOKEN.mul(10000).toString())
    await voteTokenContract.connect(deployer).mint(ONE_VOTE_TOKEN.mul(10000).toString())

    console.log('Transferring funds...')
    await loanCcyTokenContract.connect(deployer).transfer(alice.address, ONE_LOAN_TOKEN.mul(100).toString())
    await collCcyTokenContract.connect(deployer).transfer(alice.address, ONE_COLL_TOKEN.mul(100).toString())
    await voteTokenContract.connect(deployer).transfer(alice.address, ONE_VOTE_TOKEN.mul(100).toString())

    await loanCcyTokenContract.connect(deployer).transfer(bob.address, ONE_LOAN_TOKEN.mul(100).toString())
    await collCcyTokenContract.connect(deployer).transfer(bob.address, ONE_COLL_TOKEN.mul(100).toString())
    await voteTokenContract.connect(deployer).transfer(bob.address, ONE_VOTE_TOKEN.mul(100).toString())

    await loanCcyTokenContract.connect(deployer).transfer(charlie.address, ONE_LOAN_TOKEN.mul(100).toString())
    await collCcyTokenContract.connect(deployer).transfer(charlie.address, ONE_COLL_TOKEN.mul(100).toString())
    await voteTokenContract.connect(deployer).transfer(charlie.address, ONE_VOTE_TOKEN.mul(100).toString())
}

async function deploy () {
    console.log('Compiling...')

    const controllerContractBlueprint = await hre.ethers.getContractFactory('Controller')
    console.log('Controller compiled')

    const contractBlueprint = await hre.ethers.getContractFactory('BasePool')
    console.log('Contract compiled')


    console.log('Deploying...')
    controllerContract = await controllerContractBlueprint.deploy(
        VOTE_TOKEN,
        PAUSE_THRESHOLD,
        UNPAUSE_THRESHOLD,
        WHITELIST_THRESHOLD,
        DEWHITELIST_THRESHOLD,
        String(SNAPSHOT_TOKEN_EVERY),
        String(CONTROLLER_LOCK_PERIOD),
        deployer.address
    )
    console.log('Controller deployed to:', controllerContract.address)

    expect(controllerContract.address).to.be.a('string')
    expect(await controllerContract.voteToken()).to.be.deep.equal(VOTE_TOKEN)
    expect(await controllerContract.pauseThreshold()).to.be.deep.equal(String(PAUSE_THRESHOLD))
    expect(await controllerContract.unpauseThreshold()).to.be.deep.equal(String(UNPAUSE_THRESHOLD))
    expect(await controllerContract.whitelistThreshold()).to.be.deep.equal(String(WHITELIST_THRESHOLD))
    expect(await controllerContract.dewhitelistThreshold()).to.be.deep.equal(String(DEWHITELIST_THRESHOLD))
    expect(await controllerContract.snapshotTokenEvery()).to.be.deep.equal(String(SNAPSHOT_TOKEN_EVERY))
    expect(await controllerContract.lockPeriod()).to.be.deep.equal(String(CONTROLLER_LOCK_PERIOD))
    expect(await controllerContract.vetoHolder()).to.be.deep.equal(String(deployer.address))

    const poolCreationParams = ethers.utils.defaultAbiCoder.encode(POOL_CONSTRUCTOR_ARGS_ABI, [
        [LOAN_CCY_TOKEN, COLL_CCY_TOKEN],
        DECIMALS,
        LOAN_TENOR,
        MAX_LOAN_PER_COLL,
        [R1, R2],
        [LIQUIDITY_BND_1, LIQUIDITY_BND_2],
        MIN_LOAN,
        CREATOR_FEE,
        MIN_LIQUIDITY,
        controllerContract.address,
        REWARD_COEFFICIENT,
    ])
    const poolCreationTx = await controllerContract.createPool(contractBlueprint.bytecode, poolCreationParams, { gasLimit: 8000000 })
    const poolCreationReceipt = await poolCreationTx.wait()
    const poolCreatedEvent = poolCreationReceipt.events?.find((event: any) => event.event === 'PoolCreated')
    if (!poolCreatedEvent?.args?.pool) {
        throw new Error('Controller.createPool did not emit PoolCreated')
    }
    contract = contractBlueprint.attach(poolCreatedEvent.args.pool)
    console.log('Contract deployed to:', contract.address)

    expect(contract.address).to.be.a('string')

    await checkQuery('getPoolInfo', [],
        [
            LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
            0, 0, REWARD_COEFFICIENT, 1
        ]
    )

    multiclaimContract = (await hre.ethers.getContractFactory('MultiClaim')).deploy()

    const emergencyWithdrawalContractBlueprint = await hre.ethers.getContractFactory('EmergencyWithdrawal')
    const emergencyWithdrawalContract = await emergencyWithdrawalContractBlueprint.deploy()
    console.log('Emergency withdrawal contract deployed to:', emergencyWithdrawalContract.address)

    const bits = approvalBits(['removeLiquidity'])
    await contract.connect(alice).setApprovals(emergencyWithdrawalContract.address, bits)

    await emergencyWithdrawalContract.connect(alice).approve(contract.address, EMERGENCY_ESCROW)

    // Send 1 ETH to EMERGENCY_ESCROW
    await alice.sendTransaction({to: EMERGENCY_ESCROW, value: ethers.utils.parseEther("1.0") })

    console.log(`Alice (${alice.address}) approved ${EMERGENCY_ESCROW} on ${emergencyWithdrawalContract.address} to withdraw her funds from ${contract.address}`)
}
async function whitelistContract () {
    // Charlie will vote for the contract to be whitelisted
    await voteTokenContract.connect(charlie).approve(controllerContract.address, ONE_VOTE_TOKEN.mul(81))
    await controllerContract.connect(charlie).depositRewardSupply(ONE_VOTE_TOKEN.mul(80))

    await controllerContract.connect(charlie).depositVoteToken(ONE_VOTE_TOKEN.mul(1))

    await controllerContract.connect(charlie).createProposal(contract.address, Actions.Whitelist, getTimestamp() + 1000)
    await controllerContract.connect(charlie).vote(0)
    await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

    // await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)
}

async function testContract () {
    // As a sanity test, we're going to add liquidity, borrow, repay and check the state of the contract

    const liquidity = ONE_LOAN_TOKEN.mul(40)
    const collateralPledge = ONE_COLL_TOKEN.mul(8)
    const shares = liquidity.mul(1000).div(MIN_LIQUIDITY)

    await loanCcyTokenContract.connect(alice).approve(contract.address, liquidity)
    await contract.connect(alice).addLiquidity(alice.address, String(liquidity), getTimestamp() + 1000, 0)

    const loanTerms = await contract.loanTerms(collateralPledge)

    console.log('Loan terms:', loanTerms)

    const loanAmount = loanTerms.loanAmount
    const repaymentAmount = loanTerms.repaymentAmount

    await collCcyTokenContract.connect(bob).approve(contract.address, collateralPledge)
    await contract.connect(bob).borrow(bob.address, // onBehalfOf
            String(collateralPledge),
            loanAmount, // minLoanLimit
            repaymentAmount, // maxRepayLimit
            getTimestamp() + 1000, // deadline
            0 // referralCode
        )

    await checkQuery('getPoolInfo', [],
        [
            LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
            liquidity.sub(loanAmount), shares, REWARD_COEFFICIENT, 2
        ]
    )
    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(ONE_LOAN_TOKEN.mul(100).add(loanAmount))

    // The contract doesn't allow atomic borrow + repay
    // await setTime(2)

    await loanCcyTokenContract.connect(bob).approve(contract.address, repaymentAmount)
    const tx1 = await contract.connect(bob).repay(
        1,
        bob.address
    )

    await checkEvents(tx1, [
        {
            borrower : bob.address,
            loanIdx : 1,
            repaymentAmountAfterFees : repaymentAmount
        }
    ])

    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(ONE_LOAN_TOKEN.mul(100).add(loanAmount).sub(repaymentAmount))
    expect(await collCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(ONE_COLL_TOKEN.mul(100).sub(collateralPledge.mul(CREATOR_FEE).div(MONE)))
}

async function main() {
    await setup()
    await deploy()
    await whitelistContract()
    await testContract()
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
})
