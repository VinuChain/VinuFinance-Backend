//import { describe } from "mocha";
import { BigNumber } from "@ethersproject/bignumber";

import chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { isNumberObject } from "util/types"


import hre from 'hardhat'
import { ethers } from "hardhat"

chai.use(chaiAsPromised);
const expect = chai.expect

let deployer: any;

let controllerContractBlueprint : hre.ethers.ContractFactory
let contractBlueprint: ethers.ContractFactory
let multiclaimContractBlueprint: ethers.ContractFactory
let emergencyWithdrawalContractBlueprint: ethers.ContractFactory

let controllerContract : any;
let contract: any;
let emergencyWithdrawalContract : any;
let mnemonicCounter = 1

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'


const MONE = BigNumber.from('1000000000000000000') //10**18
let LOAN_CCY_TOKEN : string
let COLL_CCY_TOKEN : string

let loanCcyTokenContract : any
let collCcyTokenContract : any

const LOAN_TENOR = 86400
const MAX_LOAN_PER_COLL = '1'//ONE_VITE.toString()
const R1 = MONE.mul(2).div(10).toString()
const R2 = MONE.mul(2).div(100).toString()
const LIQUIDITY_BND_1 = '5000' //ONE_VITE.mul(100000).toString()
const LIQUIDITY_BND_2 = '10000' //ONE_VITE.mul(1000000).toString()
const MIN_LOAN = '200'//ONE_VITE.mul(100).toString()
const DECIMALS = 0 //18
const MIN_LIQUIDITY = 5000
const MIN_LPING_PERIOD = 120

const CREATOR_FEE = 8

let voteTokenContract : any

let VOTE_TOKEN : string
const SNAPSHOT_TOKEN_EVERY = 100 
const PAUSE_THRESHOLD = 2000 // 20%
const UNPAUSE_THRESHOLD = 3000 // 30%
const WHITELIST_THRESHOLD = 8000 // 80%
const DEWHITELIST_THRESHOLD = 7000 // 70%
const CONTROLLER_LOCK_PERIOD = 10
// Reward coefficient for the core suite. Defaults to '0' (the historical value
// the inherited MYSO core suite was written against; see audit finding T1).
// Override via REWARD_COEFFICIENT env var to exercise the whole share-array
// edge-case suite under live rewards, e.g. REWARD_COEFFICIENT=1000000000000000
// (1e15). The suite's own equality assertions reference this same constant, so a
// non-zero value re-runs every scenario with the reward bookkeeping fully active.
const REWARD_COEFFICIENT = process.env.REWARD_COEFFICIENT ?? '0'

const Actions = {
    Pause : 0,
    Unpause : 1,
    Whitelist : 2,
    Dewhitelist : 3
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

const newUsers = async (...tokenInfos : Array<Array<Array<String | Number>>>) => {
    const users : Array<any> = []
    for (const tokenInfo of tokenInfos) {
        const [...allUsers] = await ethers.getSigners() //vite.newAccount(config.networks.local.mnemonic, mnemonicCounter++, provider)
        const user = allUsers[mnemonicCounter++]

        const currentTokens = [loanCcyTokenContract, collCcyTokenContract, voteTokenContract]
        const currentContracts = [contract, controllerContract]

        for (const tokenPair of tokenInfo) {
            const matchingToken = currentTokens.find(x => x.address == tokenPair[0])
            
            await matchingToken.connect(user).mint(String(tokenPair[1]))

            for (const currentContract of currentContracts) {
                if (currentContract) {
                    await matchingToken.connect(user).approve(currentContract.address, String(tokenPair[1]))
                }
            }
        }

        users.push(user)
    }

    return users
}

const setTime = async (newTime : Number, referenceContract : ethers.Contract | undefined = undefined) => {
    if (!referenceContract) {
        referenceContract = contract
    }
    await referenceContract.connect(deployer).setTime(newTime)
}


const whitelistContract = async () => {
    const [manager] = await newUsers([ [VOTE_TOKEN, 10000100] ])
    await controllerContract.connect(manager).depositRewardSupply('10000000')

    await controllerContract.connect(manager).depositVoteToken(String(100))

    await controllerContract.connect(manager).createProposal(contract.address, Actions.Whitelist, 1000000)
    await controllerContract.connect(manager).vote(0)
    await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

    await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)
}


describe('test BasePool', function () {
    before(async function() {
        //provider = await vite.newProvider('http://127.0.0.1:23456')
        //deployer = vite.newAccount(config.networks.local.mnemonic, 0, provider)

        console.log('Creating signer...')
        const [a] = await ethers.getSigners();
        deployer = a

        const erc20Blueprint = await hre.ethers.getContractFactory('MockERC20')

        loanCcyTokenContract = await erc20Blueprint.deploy()
        LOAN_CCY_TOKEN = loanCcyTokenContract.address


        collCcyTokenContract = await erc20Blueprint.deploy()
        COLL_CCY_TOKEN = collCcyTokenContract.address

        voteTokenContract = await erc20Blueprint.deploy()
        VOTE_TOKEN = voteTokenContract.address

        //await transpileContract('contracts/BasePool.solpp')
        //await transpileContract('contracts/Controller.solpp')

        controllerContractBlueprint = await hre.ethers.getContractFactory('Controller_parsed')

        contractBlueprint = await hre.ethers.getContractFactory('BasePool_parsed')

        multiclaimContractBlueprint = await hre.ethers.getContractFactory('MultiClaim')

        emergencyWithdrawalContractBlueprint = await hre.ethers.getContractFactory('EmergencyWithdrawal')
    })

    describe('contract deployment', function () {
        it('deploys the contract', async function() {

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

            expect(controllerContract.address).to.be.a('string')
            expect(await controllerContract.voteToken()).to.be.deep.equal(VOTE_TOKEN)
            expect(await controllerContract.pauseThreshold()).to.be.deep.equal(String(PAUSE_THRESHOLD))
            expect(await controllerContract.unpauseThreshold()).to.be.deep.equal(String(UNPAUSE_THRESHOLD))
            expect(await controllerContract.whitelistThreshold()).to.be.deep.equal(String(WHITELIST_THRESHOLD))
            expect(await controllerContract.dewhitelistThreshold()).to.be.deep.equal(String(DEWHITELIST_THRESHOLD))
            expect(await controllerContract.snapshotTokenEvery()).to.be.deep.equal(String(SNAPSHOT_TOKEN_EVERY))
            expect(await controllerContract.lockPeriod()).to.be.deep.equal(String(CONTROLLER_LOCK_PERIOD))
            expect(await controllerContract.vetoHolder()).to.be.deep.equal(String(deployer.address))

            contract = await contractBlueprint.deploy(
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
                REWARD_COEFFICIENT
            )

            expect(contract.address).to.be.a('string')

            await checkQuery('getPoolInfo', [],
                [
                    LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                    0, 0, REWARD_COEFFICIENT, 1
                ]
            )

            /*await checkEvents([{
                loanCcyToken : LOAN_CCY_TOKEN,
                collCcyToken : COLL_CCY_TOKEN,
                loanTenor : LOAN_TENOR,
                maxLoanPerColl : MAX_LOAN_PER_COLL,
                r1 : R1,
                r2 : R2,
                liquidityBnd1 : LIQUIDITY_BND_1,
                liquidityBnd2 : LIQUIDITY_BND_2,
                minLoan : MIN_LOAN,
                creatorFee : CREATOR_FEE
            }])*/
        })
    })

    describe('contract execution', function () {
        beforeEach(async function () {
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

            expect(controllerContract.address).to.be.a('string')
            expect(await controllerContract.voteToken()).to.be.deep.equal(VOTE_TOKEN)
            expect(await controllerContract.pauseThreshold()).to.be.deep.equal(String(PAUSE_THRESHOLD))
            expect(await controllerContract.unpauseThreshold()).to.be.deep.equal(String(UNPAUSE_THRESHOLD))
            expect(await controllerContract.whitelistThreshold()).to.be.deep.equal(String(WHITELIST_THRESHOLD))
            expect(await controllerContract.dewhitelistThreshold()).to.be.deep.equal(String(DEWHITELIST_THRESHOLD))
            expect(await controllerContract.snapshotTokenEvery()).to.be.deep.equal(String(SNAPSHOT_TOKEN_EVERY))
            expect(await controllerContract.lockPeriod()).to.be.deep.equal(String(CONTROLLER_LOCK_PERIOD))
            expect(await controllerContract.vetoHolder()).to.be.deep.equal(String(deployer.address))

            contract = await contractBlueprint.deploy(
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
                REWARD_COEFFICIENT
            )

            expect(contract.address).to.be.a('string')

            await checkQuery('getPoolInfo', [],
                [
                    LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                    0, 0, REWARD_COEFFICIENT, 1
                ]
            )
        })
        describe('addLiquidity', function() {
            it('adds liquidity', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 10000] ])

                console.log(alice.address)

                const tx1 = await contract.connect(alice).addLiquidity(alice.address, '5000' ,150,0)

                console.log('Successfully added liquidity')

                // If this is the first time adding liquidity, the shares are 1000 * deposited / minLiquidity
                const newShares = 1000 * 5000 / MIN_LIQUIDITY

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        5000, newShares, REWARD_COEFFICIENT, 1
                    ]
                )

                await checkQuery('getLpInfo', [alice.address],
                    ['1', String(MIN_LPING_PERIOD), '0', [ '1000' ], []]
                )

                await checkEvents(tx1, [
                    // DEFAULT_CONSTRUCTOR_EVENT,
                    {
                        lp : alice.address,
                        amount : 5000,
                        newLpShares : newShares,
                        totalLiquidity : 5000,
                        totalLpShares : newShares,
                        earliestRemove : 0 + MIN_LPING_PERIOD,
                        loanIdx : 1,
                        referralCode : 0
                    }
                ])
                
            })
            it('adds liquidity multiple times', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 10000] ])

                const tx1 = await contract.connect(alice).addLiquidity(alice.address, '5000' ,150,0)
                // If this is the first time adding liquidity, the shares are 1000 * deposited / minLiquidity
                const firstShares = 1000 * 5000 / MIN_LIQUIDITY

                await checkEvents(tx1, [
                    // DEFAULT_CONSTRUCTOR_EVENT,
                    {
                        lp : alice.address,
                        amount : 5000,
                        newLpShares : firstShares,
                        totalLiquidity : 5000,
                        totalLpShares : firstShares,
                        earliestRemove : 0 + MIN_LPING_PERIOD,
                        loanIdx : 1,
                        referralCode : 0
                    }
                ])

                const tx2 = await contract.connect(alice).addLiquidity(alice.address, '2000' ,150,0)

                // More shares, using deposited / liquidity * nShares
                const secondShares = 2000 / 5000 * firstShares
                const totalShares = firstShares + secondShares


                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        5000 + 2000, firstShares + secondShares, REWARD_COEFFICIENT, 1
                    ]
                )

                await checkQuery('getLpInfo', [alice.address],
                    ['1', String(MIN_LPING_PERIOD), '0', [ '1400' ], []]
                )

                await checkEvents(tx2, [
                    // DEFAULT_CONSTRUCTOR_EVENT,
                    {
                        lp : alice.address,
                        amount : 2000,
                        newLpShares : secondShares,
                        totalLiquidity : 7000,
                        totalLpShares : totalShares,
                        earliestRemove : 0 + MIN_LPING_PERIOD,
                        loanIdx : 1,
                        referralCode : 0
                    }
                ])
                
            })
            it('adds liquidity with rounding', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 10000] ])

                const tx1 = await contract.connect(alice).addLiquidity(alice.address, '5004' ,150,0)

                // If this is the first time adding liquidity, the shares are 1000 * deposited / minLiquidity
                // Note that MIN_LIQUIDITY / 1000 = 5, so you get slightly less shares than expected
                const newShares = 1000 * 5000 / MIN_LIQUIDITY

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        5004, newShares, REWARD_COEFFICIENT, 1
                    ]
                )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        amount : 5004,
                        newLpShares : newShares,
                        totalLiquidity : 5004,
                        totalLpShares : newShares,
                        earliestRemove : 0 + MIN_LPING_PERIOD,
                        loanIdx : 1,
                        referralCode : 0
                    }
                ])
            })
            it('adds liquidity for an authorized address', async function () {
                const [alice, bob] = await newUsers([], [ [LOAN_CCY_TOKEN, 10000] ])

                console.log('Alice: ', alice.address)
                console.log('Bob: ', bob.address)

                const bits = approvalBits(['addLiquidity'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(bob.address, bits)

                const tx1 = await contract.connect(bob).addLiquidity(alice.address, '5000' ,150,0)

                // If this is the first time adding liquidity, the shares are 1000 * deposited / minLiquidity
                const newShares = 1000 * 5000 / MIN_LIQUIDITY

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        5000, newShares, REWARD_COEFFICIENT, 1
                    ]
                )

                await checkEvents(tx1, [
                    // DEFAULT_CONSTRUCTOR_EVENT,
                    {
                        lp : alice.address,
                        amount : 5000,
                        newLpShares : newShares,
                        totalLiquidity : 5000,
                        totalLpShares : newShares,
                        earliestRemove : 0 + MIN_LPING_PERIOD,
                        loanIdx : 1,
                        referralCode : 0
                    }
                ])
            })
            it('fails to add liquidity without being authorized', async function () {
                const [alice, bob] = await newUsers([], [ [LOAN_CCY_TOKEN, 10000] ])

                const bits = approvalBits(['repay', 'removeLiquidity', 'claim', 'forceRewardUpdate'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(bob.address, bits)

                await expect(contract.connect(bob).addLiquidity( 
                    alice.address, // onBehalfOf
                    '5000',
                    150, // deadline
                    0 // referralCode
                )).to.be.revertedWith('Sender not approved.')
            })
            it('fails to add liquidity with an incorrect token', async function () {
                const [alice] = await newUsers([ [COLL_CCY_TOKEN, 10000] ])

                await expect(contract.connect(alice).addLiquidity(
                    alice.address, // onBehalfOf
                    '5000',
                    150, // deadline
                    0 // referralCode
                )).to.be.revertedWith('ERC20: insufficient allowance')
            })
            it('fails to add liquidity after the deadline', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 10000] ])

                await setTime(151)

                await expect(contract.connect(alice).addLiquidity( 
                    alice.address, // onBehalfOf
                    '5000',
                    150, // deadline
                    0 // referralCode
                )).to.be.revertedWith('Past deadline.')
            })
            it('fails to add more liquidity than the allowance', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 10000] ])

                await loanCcyTokenContract.connect(alice).approve(contract.address, '4999')

                await expect(
                    contract.connect(alice).addLiquidity(alice.address, '5000' ,150,0)
                ).to.be.revertedWith('ERC20: insufficient allowance')

                
            })
        })

        describe('removeLiquidity', function() {
            it('removes liquidity', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ])

                await contract.connect(alice).addLiquidity(alice.address, '8000' ,150,0)
                
                const newShares = 1000 * 8000 / MIN_LIQUIDITY

                await setTime(MIN_LPING_PERIOD + 1)

                const tx1 = await contract.connect(alice).removeLiquidity(
                        alice.address, // onBehalfOf
                        200 // shares
                    )

                // The removal formula is withdrawnShares * (liquidity - minLiquidity) / totalShares
                // Note that this means that a small percentage of the liquidity is not withdrawn
                // in real-world contexts this amount is very small
                const withdrawnLiquidity = 200 * (8000 - MIN_LIQUIDITY) / newShares

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        8000 - withdrawnLiquidity, newShares - 200, REWARD_COEFFICIENT, 1
                    ]
                )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        amount : withdrawnLiquidity,
                        removedLpShares : 200,
                        totalLiquidity : 8000 - withdrawnLiquidity,
                        totalLpShares : newShares - 200,
                        loanIdx : 1
                    }
                ])
            })
            it('adds and removes liquidity multiple times', async function () {
                // Whitelist, since there will be multiple contract operations (and thus requests)
                await whitelistContract()

                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 16000] ])

                await contract.connect(alice).addLiquidity(alice.address, '8000' ,150,0)

                const addedShares1 = 1000 * 8000 / MIN_LIQUIDITY
                console.log('Added 8000 liquidity, equal to', addedShares1, 'shares')

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        8000, addedShares1, REWARD_COEFFICIENT, 1
                    ]
                )

                await setTime(MIN_LPING_PERIOD + 1)

                await contract.connect(alice).removeLiquidity(
                        alice.address, // onBehalfOf
                        200 // shares
                    )

                // The removal formula is withdrawnShares * (liquidity - minLiquidity) / totalShares
                // Note that this means that a small percentage of the liquidity is not withdrawn
                // in real-world contexts this amount is very small
                const withdrawnLiquidity1 = Math.floor(200 * (8000 - MIN_LIQUIDITY) / addedShares1)
                console.log('Withdrawn 200 shares, equal to', withdrawnLiquidity1, 'liquidity')

                const finalLiquidity1 = 8000 - withdrawnLiquidity1
                const finalShares1 = addedShares1 - 200

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        finalLiquidity1, addedShares1 - 200, REWARD_COEFFICIENT, 1
                    ]
                )

                await contract.connect(alice).addLiquidity(alice.address, '6000' ,150,0)

                // For non-first deposits, the formula is deposit / totalLiquidity * totalShares
                
                const addedShares2 = Math.floor(6000 / finalLiquidity1 * finalShares1)
                console.log('Added 6000 liquidity, equal to', addedShares2, 'shares')

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        finalLiquidity1 + 6000, finalShares1 + addedShares2, REWARD_COEFFICIENT, 1
                    ]
                )

                await setTime(2 * (MIN_LPING_PERIOD + 1))

                const tx1 = await contract.connect(alice).removeLiquidity(
                        alice.address, // onBehalfOf
                        200 // shares
                    )

                // The removal formula is withdrawnShares * (totalLiquidity - minLiquidity) / totalShares
                const withdrawnLiquidity2 = Math.floor(200 * (finalLiquidity1 + 6000 - MIN_LIQUIDITY) / (finalShares1 + addedShares2))

                console.log('Withdrawn 200 shares, equal to', withdrawnLiquidity2, 'liquidity')

                const finalLiquidity2 = finalLiquidity1 + 6000 - withdrawnLiquidity2
                const finalShares2 = finalShares1 + addedShares2 - 200

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        finalLiquidity2, finalShares2, REWARD_COEFFICIENT, 1
                    ]
                )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        amount : withdrawnLiquidity2,
                        removedLpShares : 200,
                        totalLiquidity : finalLiquidity2,
                        totalLpShares : finalShares2,
                        loanIdx : 1
                    }
                ])
            })
            
            it('removes enough liquidity to cause the total liquidity to go below the minimum', async function() {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 20000] ])

                await contract.connect(alice).addLiquidity(alice.address, '20000' ,150,0)
                
                const newShares = 1000 * 20000 / MIN_LIQUIDITY; // Equal to 4000

                await setTime(MIN_LPING_PERIOD + 1)

                const tx1 = await contract.connect(alice).removeLiquidity(
                        alice.address, // onBehalfOf
                        3000 // shares
                    )

                // The removal formula is withdrawnShares * (liquidity - minLiquidity) / totalShares
                // However, only 3000 shares (equivalent to 15000 liquidity) will be removed,
                // leaving 1000 shares (equivalent to 5000 liquidity) in the contract

                const withdrawnLiquidity = 3000 * (20000 - MIN_LIQUIDITY) / newShares

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        20000 - withdrawnLiquidity, newShares - 3000, REWARD_COEFFICIENT, 1
                    ]
                )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        amount : withdrawnLiquidity,
                        removedLpShares : 3000,
                        totalLiquidity : 20000 - withdrawnLiquidity,
                        totalLpShares : 1000,
                        loanIdx : 1
                    }
                ])
            })
            it('removes liquidity for an authorized address', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [])

                await contract.connect(alice).addLiquidity(alice.address, '8000' ,150,0)
                
                const newShares = 1000 * 8000 / MIN_LIQUIDITY

                const bits = approvalBits(['removeLiquidity'])
                await contract.connect(alice).setApprovals(bob.address, bits)

                await setTime(MIN_LPING_PERIOD + 1)

                const tx1 = await contract.connect(bob).removeLiquidity(
                        alice.address, // onBehalfOf
                        200 // shares
                    )

                // The removal formula is withdrawnShares * (liquidity - minLiquidity) / totalShares
                // Note that this means that a small percentage of the liquidity is not withdrawn
                // in real-world contexts this amount is very small
                const withdrawnLiquidity = Math.floor(200 * (8000 - MIN_LIQUIDITY) / newShares)

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        8000 - withdrawnLiquidity, newShares - 200, REWARD_COEFFICIENT, 1
                    ]
                )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        amount : withdrawnLiquidity,
                        removedLpShares : 200,
                        totalLiquidity : 8000 - withdrawnLiquidity,
                        totalLpShares : newShares - 200,
                        loanIdx : 1
                    }
                ])

                // The money goes to Bob!
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal('0')
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(withdrawnLiquidity))
            })
            it('fails to remove liquidity without being authorized', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [])

                await contract.connect(alice).addLiquidity(alice.address, '8000' ,150,0)

                const bits = approvalBits(['repay', 'addLiquidity', 'claim', 'forceRewardUpdate'])
                await contract.connect(alice).setApprovals(bob.address, bits)

                await setTime(MIN_LPING_PERIOD + 1)

                await expect(contract.connect(bob).removeLiquidity(
                        alice.address, // onBehalfOf
                        200 // shares
                    )).to.be.revertedWith('Sender not approved.')
            })
            it('fails to remove more liquidity than the user has', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ])

                await contract.connect(alice).addLiquidity(alice.address, '8000' ,150,0)
                
                const newShares = 1000 * 8000 / MIN_LIQUIDITY

                await setTime(MIN_LPING_PERIOD + 1)

                expect(contract.connect(alice).removeLiquidity(
                        alice.address, // onBehalfOf
                        newShares + 1 // shares
                    )).to.be.revertedWith('Invalid removal operation.')
            })
            it('fails to remove liquidity before the minimum timestamp', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ])

                await contract.connect(alice).addLiquidity(alice.address, '8000' ,150,0)
                
                const newShares = 1000 * 8000 / MIN_LIQUIDITY

                await setTime(MIN_LPING_PERIOD - 1)

                expect(contract.connect(alice).removeLiquidity(
                        alice.address, // onBehalfOf
                        newShares // shares
                    )).to.be.revertedWith('Too early to remove.')
            })
        })

        describe('borrow', function() {
            it('borrows', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                const tx1 = await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )

                await checkEvents(tx1, [{
                    borrower : bob.address,
                    loanIdx : 1,
                    collateral : collateralPledge,
                    loanAmount,
                    repaymentAmount,
                    totalLpShares : shares,
                    expiry : 1 + LOAN_TENOR,
                    referralCode : 0
                }])
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(loanAmount))
                
            })
            it('borrows while being a lender', async function () {
                const [alice] = await newUsers([ [LOAN_CCY_TOKEN, 8000] , [COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                const tx1 = await contract.connect(alice).borrow(alice.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkEvents(tx1, [{
                    borrower : alice.address,
                    loanIdx : 1,
                    collateral : collateralPledge,
                    loanAmount,
                    repaymentAmount,
                    totalLpShares : shares,
                    expiry : 1 + LOAN_TENOR,
                    referralCode : 0
                }])

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(loanAmount))
            })
            it('fails to borrow after the deadline', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)

                await setTime(151)

                await expect(contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )).to.be.revertedWith('Past deadline.')
            })
            it('fails to borrow below the minimum loan limit', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await expect(contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 429, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )).to.be.revertedWith('Loan below limit.')
            })
            it('fails to borrow above the maximum repay limit', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await expect(contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        469, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )).to.be.revertedWith('Repayment above limit.')
            })
            it('fails to borrow when the liquidity is below minimum', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[COLL_CCY_TOKEN, 8000]])

                const liquidity = 4999
                const collateralPledge = 500

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await expect(contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 1, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )).to.be.revertedWith('Insufficient liquidity.')
            })
            it('fails to borrow with zero collateral', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 0

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await expect(contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 0, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )).to.be.revertedWith('Loan too small.')
            })
            it('fails to add liquidity and borrow atomically', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)

                await expect(contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )).to.be.revertedWith('Invalid operation.')
            })
        })

        describe('repay', function() {
            it('repays a loan', async function () {
                const [alice, bob] = await newUsers(
                    [ [LOAN_CCY_TOKEN, 8000] ],
                    [ [LOAN_CCY_TOKEN, 10000], [COLL_CCY_TOKEN, 8000] ])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity + borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(10000 + loanAmount))

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

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

                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(10000 + loanAmount - repaymentAmount))
                expect(await collCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(8000))
            })

            it('repays for an authorized address', async function () {
                // Bob borrows and Charlie repays
                const [alice, bob, charlie] = await newUsers(
                    [ [LOAN_CCY_TOKEN, 10000] ],
                    [ [COLL_CCY_TOKEN, 10000] ],
                    [ [LOAN_CCY_TOKEN, 10000] ])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                
                const bits = approvalBits(['repay'])
                console.log('Bits:', bits)
                await contract.connect(bob).setApprovals(charlie.address, bits)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity + borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(loanAmount))

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                const tx1 = await contract.connect(charlie).repay(
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

                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(loanAmount))
                expect(await loanCcyTokenContract.balanceOf(charlie.address)).to.be.deep.equal(String(10000 - repaymentAmount))
            })

            it('fails to repay without being authorized', async function () {
                // Bob borrows and Charlie repays
                const [alice, bob, charlie] = await newUsers(
                    [ [LOAN_CCY_TOKEN, 10000] ],
                    [ [COLL_CCY_TOKEN, 10000] ],
                    [ [LOAN_CCY_TOKEN, 10000] ])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                
                const bits = approvalBits(['addLiquidity', 'removeLiquidity', 'claim', 'forceRewardUpdate'])
                console.log('Bits:', bits)
                await contract.connect(bob).setApprovals(charlie.address, bits)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity + borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(loanAmount))

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await expect(
                    contract.connect(charlie).repay(
                        1,
                        bob.address
                    )
                ).to.be.revertedWith('Sender not approved.')
            })

            it('fails to repay after the deadline', async function () {
                const [alice, bob] = await newUsers(
                    [ [LOAN_CCY_TOKEN, 8000] ],
                    [ [LOAN_CCY_TOKEN, 10000], [COLL_CCY_TOKEN, 8000] ])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity + borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )


                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(10000 + loanAmount))

                
                await setTime(LOAN_TENOR + 2)

                await expect(
                    contract.connect(bob).repay(
                        1,
                        bob.address
                    )
                ).to.be.revertedWith('Cannot repay after expiry.')
            })
            it('fails to repay an invalid loan', async function () {
                const [alice, bob] = await newUsers(
                    [ [LOAN_CCY_TOKEN, 8000] ],
                    [ [LOAN_CCY_TOKEN, 10000], [COLL_CCY_TOKEN, 8000] ])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity + borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(10000 + loanAmount))

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await expect(
                    contract.connect(bob).repay(
                    2, // Instead of 1
                    bob.address
                )
                ).to.be.revertedWith('Invalid loan index.')
            })
            it('fails to repay an already repaid loan', async function () {
                const [alice, bob] = await newUsers(
                    [ [LOAN_CCY_TOKEN, 8000] ],
                    [ [LOAN_CCY_TOKEN, 10000], [COLL_CCY_TOKEN, 8000] ])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity + borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(10000 + loanAmount))

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(bob).repay(
                    1,
                    bob.address
                )

                await expect(
                    contract.connect(bob).repay(
                    1,
                    bob.address
                )
                ).to.be.revertedWith('Already repaid.')
            })
            it('fails to borrow and repay atomically', async function () {
                const [alice, bob] = await newUsers(
                    [ [LOAN_CCY_TOKEN, 8000] ],
                    [ [LOAN_CCY_TOKEN, 10000], [COLL_CCY_TOKEN, 8000] ])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity + borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(10000 + loanAmount))

                await expect(
                    contract.connect(bob).repay(
                        1,
                        bob.address
                    )
                ).to.be.revertedWith('Cannot repay in the same block.')
            })
        })

        describe('claim', function() {
            it('claims the repayment for a successful loan', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                const shares2 = Math.floor((repaymentAmount - loanAmount) / (liquidity - loanAmount) * shares)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(bob).repay(
                    1,
                    bob.address
                )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1],
                        0, // Don't reinvest
                        150
                    )

                // The liquidity and shares don't change because the user didn't reinvest
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                await checkEvents(tx1, [{
                    lp : alice.address,
                    loanIdxs : [1],
                    repayments : repaymentAmount,
                    collateral : 0
                }])
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(8000 - liquidity + repaymentAmount))
            })

            it('claims the repayment for a successful loan and re-invests', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                const shares2 = Math.floor(repaymentAmount / (liquidity - loanAmount) * shares)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(bob).repay(
                    1,
                    bob.address
                )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1],
                        1, // Reinvest
                        150
                    )

                // The liquidity and shares don't change because the user didn't reinvest
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount + repaymentAmount, shares + shares2, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, 2 + MIN_LPING_PERIOD, 0, [shares + shares2], []
                    ]
                )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        repayments : repaymentAmount,
                        newLpShares : shares2,
                        earliestRemove : 2 + MIN_LPING_PERIOD,
                        loanIdx : 2
                    },
                    {
                        lp : alice.address,
                        loanIdxs : [1],
                        repayments : repaymentAmount,
                        collateral : 0
                    }
                ])
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(8000 - liquidity))
            })

            it('claims the repayment for multiple loans and re-invests', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 12000], [COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                const loanAmount2 = 418
                const repaymentAmount2 = 596

                const shares2 = Math.floor(repaymentAmount / (liquidity - loanAmount - loanAmount2) * shares)

                // Note that although claiming the second loan is done after claimining the first loan, the liqudiity isn't
                // already updated with repaymentAmount. That's because the contract first computes all the repayments and
                // then deposits the new liquidity at the end
                const shares3 = Math.floor(repaymentAmount2 / (liquidity - loanAmount - loanAmount2) * (shares))

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(bob).repay(
                    1,
                    bob.address
                )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                await contract.connect(bob).repay(
                    2,
                    bob.address
                )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1, 2],
                        1, // Reinvest
                        150
                    )

                // The liquidity and shares don't change because the user didn't reinvest
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2 + repaymentAmount + repaymentAmount2, shares + shares2 + shares3, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        3, 2 + MIN_LPING_PERIOD, 0, [shares + shares2 + shares3], []
                    ]
                )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        repayments : repaymentAmount + repaymentAmount2,
                        newLpShares : shares2 + shares3,
                        earliestRemove : 2 + MIN_LPING_PERIOD,
                        loanIdx : 3
                    },
                    {
                        lp : alice.address,
                        loanIdxs : [1, 2],
                        repayments : repaymentAmount + repaymentAmount2,
                        collateral : 0
                    }
                ])
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(8000 - liquidity))
            })

            it('splits the loan interest among two parties', async function () {
                const [alice, bob, charlie] = await newUsers([ [LOAN_CCY_TOKEN, 6000] ], [[ LOAN_CCY_TOKEN, 2000]],  [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidityAlice = 6000
                const liquidityBob = 2000
                const liquidity = liquidityAlice + liquidityBob
                const collateralPledge = 500
                const sharesAlice = 1000 * liquidityAlice / MIN_LIQUIDITY
                const sharesBob = Math.floor(liquidityBob / liquidityAlice * sharesAlice)
                const shares = sharesAlice + sharesBob

                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
                const repaymentAlice = Math.floor(repaymentAmount * liquidityAlice / liquidity)
                const repaymentBob = Math.floor(repaymentAmount * liquidityBob / liquidity)

                //const shares2 = Math.floor((repaymentAmount - loanAmount) / (liquidity - loanAmount) * shares)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice) ,150,0)

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob) ,150,0)

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(charlie).repay(
                    1,
                    charlie.address
                )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1],
                        0, // Don't reinvest
                        150
                    )

                // The liquidity and shares don't change because the user didn't reinvest
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                await checkEvents(tx1, [{
                    lp : alice.address,
                    loanIdxs : [1],
                    repayments : repaymentAlice,
                    collateral : 0
                }])
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(repaymentAlice))

                const tx2 = await contract.connect(bob).claim(
                        bob.address,
                        [1],
                        0, // Don't reinvest
                        150
                    )

                // The liquidity and shares don't change because the user didn't reinvest
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        2, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                await checkEvents(tx2, [{
                    lp : bob.address,
                    loanIdxs : [1],
                    repayments : repaymentBob,
                    collateral : 0
                }])
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(repaymentBob))
            })

            it('splits the loan interest among two parties (with re-invest)', async function () {
                const [alice, bob, charlie] = await newUsers([ [LOAN_CCY_TOKEN, 6000] ], [[ LOAN_CCY_TOKEN, 2000]],  [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidityAlice = 6000
                const liquidityBob = 2000
                const liquidity = liquidityAlice + liquidityBob
                const collateralPledge = 500
                const sharesAlice = 1000 * liquidityAlice / MIN_LIQUIDITY
                const sharesBob = Math.floor(liquidityBob / liquidityAlice * sharesAlice)
                const shares = sharesAlice + sharesBob

                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
                const repaymentAlice = Math.floor(repaymentAmount * liquidityAlice / liquidity)
                const repaymentBob = Math.floor(repaymentAmount * liquidityBob / liquidity)

                const shares2Alice = Math.floor(repaymentAmount / (liquidity - loanAmount) * sharesAlice)
                const shares2Bob = Math.floor(repaymentAmount / (liquidity - loanAmount) * sharesBob)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice) ,150,0)

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob) ,150,0)

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(charlie).repay(
                    1,
                    charlie.address
                )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1],
                        1, // Reinvest
                        150
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount + repaymentAlice, shares + shares2Alice, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, MIN_LPING_PERIOD + 2, 0, [sharesAlice + shares2Alice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        repayments : repaymentAlice,
                        newLpShares : shares2Alice,
                        earliestRemove : 2 + MIN_LPING_PERIOD,
                        loanIdx : 2
                    },
                    {
                        lp : alice.address,
                        loanIdxs : [1],
                        repayments : repaymentAlice,
                        collateral : 0
                    }
                ])
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(0))

                const tx2 = await contract.connect(bob).claim(
                        bob.address,
                        [1],
                        1, // Reinvest
                        150
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount + repaymentAlice + repaymentBob, shares + shares2Alice + shares2Bob, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, MIN_LPING_PERIOD + 2, 0, [sharesAlice + shares2Alice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        2, MIN_LPING_PERIOD + 2, 0, [sharesBob + shares2Bob], []
                    ]
                )

                await checkEvents(tx2, [
                    {
                        lp : bob.address,
                        repayments : repaymentBob,
                        newLpShares : shares2Bob,
                        earliestRemove : 2 + MIN_LPING_PERIOD,
                        loanIdx : 2
                    },
                    {
                        lp : bob.address,
                        loanIdxs : [1],
                        repayments : repaymentBob,
                        collateral : 0
                    }
                ])
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(0))
            })

            it('checks that claiming without re-investing and then re-depositing is the same as re-investing', async function () {
                const [alice, bob, charlie] = await newUsers([ [LOAN_CCY_TOKEN, 6000] ], [[ LOAN_CCY_TOKEN, 2000]],  [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidityAlice = 6000
                const liquidityBob = 2000
                const liquidity = liquidityAlice + liquidityBob
                const collateralPledge = 500
                const sharesAlice = 1000 * liquidityAlice / MIN_LIQUIDITY
                const sharesBob = Math.floor(liquidityBob / liquidityAlice * sharesAlice)
                const shares = sharesAlice + sharesBob

                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
                const repaymentAlice = Math.floor(repaymentAmount * liquidityAlice / liquidity)
                const repaymentBob = Math.floor(repaymentAmount * liquidityBob / liquidity)

                const shares2Alice = Math.floor(repaymentAmount / (liquidity - loanAmount) * sharesAlice)
                const shares2Bob = Math.floor(repaymentAmount / (liquidity - loanAmount) * sharesBob)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice) ,150,0)

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob) ,150,0)

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(charlie).repay(
                    1,
                    charlie.address
                )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                await contract.connect(alice).claim(
                        alice.address,
                        [1],
                        0, // Don't reinvest
                        150
                    )

                // The liquidity and shares don't change because the user didn't reinvest
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(repaymentAlice))

                await contract.connect(bob).claim(
                        bob.address,
                        [1],
                        1, // Reinvest
                        150
                    )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount + repaymentBob, shares + shares2Bob, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        2, MIN_LPING_PERIOD + 2, 0, [sharesBob + shares2Bob], []
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(0))

                // Alice now re-deposits what would have been her re-investment

                // We need to increase the allowance
                await loanCcyTokenContract.connect(alice).approve(contract.address, repaymentAlice)

                await contract.connect(alice).addLiquidity(alice.address, String(repaymentAlice) ,150,0)

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount + repaymentAlice + repaymentBob, shares + shares2Alice + shares2Bob, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, MIN_LPING_PERIOD + 2, 0, [sharesAlice + shares2Alice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        2, MIN_LPING_PERIOD + 2, 0, [sharesBob + shares2Bob], []
                    ]
                )
            })

            it('splits the loan interest among two parties (with in-the-middle liquidity and re-invest)', async function () {
                // Whitelist, since there will be multiple contract operations (and thus requests)
                await whitelistContract()

                const [alice, bob, charlie] = await newUsers([ [LOAN_CCY_TOKEN, 10000] ], [[ LOAN_CCY_TOKEN, 10000]],  [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidityAlice1 = 1000
                const liquidityAlice2 = 5000
                // Liquidity after the borrow
                const liquidityAlice3 = 2000
                const liquidityAlice4 = 500

                const liquidityBob1 = 400
                const liquidityBob2 = 1600
                // Liquidity after the borrow
                const liquidityBob3 = 1200
                const liquidityBob4 = 800

                const liquidityBeforeLoanAlice = liquidityAlice1 + liquidityAlice2
                const liquidityBeforeLoanBob = liquidityBob1 + liquidityBob2
                const liquidityBeforeLoan = liquidityBeforeLoanAlice + liquidityBeforeLoanBob
                const collateralPledge = 500

                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
                const repaymentAlice = Math.floor(repaymentAmount * liquidityBeforeLoanAlice / liquidityBeforeLoan)
                const repaymentBob = Math.floor(repaymentAmount * liquidityBeforeLoanBob / liquidityBeforeLoan)

                // Add the first batch of liquidity

                let currentAliceLiquidity = 0
                let currentBobLiquidity = 0

                let currentAliceShares = 0
                let currentBobShares = 0

                let currentTotalLiquidity = () => currentAliceLiquidity + currentBobLiquidity
                let currentTotalShares = () => currentAliceShares + currentBobShares

                let addLiquidity = (liquidity : number, to : string) => {
                    if (to == 'alice') {
                        currentAliceShares += Math.floor(liquidity / currentTotalLiquidity() * currentTotalShares())
                        currentAliceLiquidity += liquidity
                    } else {
                        currentBobShares += Math.floor(liquidity / currentTotalLiquidity() * currentTotalShares())
                        currentBobLiquidity += liquidity
                    }
                }

                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice1) ,150,0)

                currentAliceLiquidity += liquidityAlice1
                currentAliceShares += 1000 * liquidityAlice1 / MIN_LIQUIDITY

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob1) ,150,0)

                addLiquidity(liquidityBob1, 'bob')

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        currentTotalLiquidity(), currentTotalShares(), REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [currentAliceShares], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [currentBobShares], []
                    ]
                )                

                // Add the second batch of liquidity

                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice2) ,150,0)

                addLiquidity(liquidityAlice2, 'alice')

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob2) ,150,0)

                addLiquidity(liquidityBob2, 'bob')

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        currentTotalLiquidity(), currentTotalShares(), REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [
                            currentAliceShares
                        ], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [
                            currentBobShares
                        ], []
                    ]
                )

                const sharesBeforeLoanAlice = currentAliceShares
                const sharesBeforeLoanBob = currentBobShares
                const sharesBeforeLoan = sharesBeforeLoanAlice + sharesBeforeLoanBob

                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                currentAliceLiquidity -= loanAmount * (currentAliceShares / currentTotalShares())
                currentBobLiquidity -= loanAmount * (currentBobShares / currentTotalShares())

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        currentTotalLiquidity(), currentTotalShares(), REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [
                            currentAliceShares
                        ], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [
                            currentBobShares
                        ], []
                    ]
                )

                // Third batch of liquidity

                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice3) ,150,0)

                addLiquidity(liquidityAlice3, 'alice')

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob3) ,150,0)

                addLiquidity(liquidityBob3, 'bob')

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        currentTotalLiquidity(), currentTotalShares(), REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, 1 + MIN_LPING_PERIOD, 0, [
                            sharesBeforeLoanAlice,
                            currentAliceShares
                        ], [2]
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, 1 + MIN_LPING_PERIOD, 0, [
                            sharesBeforeLoanBob,
                            currentBobShares
                        ], [2]
                    ]
                )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(charlie).repay(
                    1,
                    charlie.address
                )

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        currentTotalLiquidity(), currentTotalShares(), REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, 1 + MIN_LPING_PERIOD, 0, [
                            sharesBeforeLoanAlice,
                            currentAliceShares
                        ], [2]
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, 1 + MIN_LPING_PERIOD, 0, [
                            sharesBeforeLoanBob,
                            currentBobShares
                        ], [2]
                    ]
                )

                const sharesBeforeClaimingAlice = currentAliceShares

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1],
                        1, // Reinvest
                        150
                    )

                addLiquidity(Math.floor(repaymentAmount * sharesBeforeLoanAlice / sharesBeforeLoan), 'alice')

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        currentTotalLiquidity(),
                        currentTotalShares(),
                        REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, 2 + MIN_LPING_PERIOD, 1, [
                            sharesBeforeLoanAlice,
                            currentAliceShares
                        ], [2]
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, 1 + MIN_LPING_PERIOD, 0, [
                            sharesBeforeLoanBob,
                            currentBobShares
                        ], [2]
                    ]
                )


                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        repayments : repaymentAlice,
                        newLpShares : currentAliceShares - sharesBeforeClaimingAlice,
                        earliestRemove : 2 + MIN_LPING_PERIOD,
                        loanIdx : 2
                    },
                    {
                        lp : alice.address,
                        loanIdxs : [1],
                        repayments : repaymentAlice,
                        collateral : 0
                    }
                ])

                // Fourth batch of liquidity

                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice4) ,150,0)

                addLiquidity(liquidityAlice4, 'alice')

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob4) ,150,0)

                addLiquidity(liquidityBob4, 'bob')


                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        currentTotalLiquidity(), currentTotalShares(), REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, 2 + MIN_LPING_PERIOD, 1, [
                            sharesBeforeLoanAlice,
                            currentAliceShares
                        ], [2]
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, 2 + MIN_LPING_PERIOD, 0, [
                            sharesBeforeLoanBob,
                            currentBobShares
                        ], [2]
                    ]
                )

                const sharesBeforeClaimingBob = currentBobShares

                const tx2 = await contract.connect(bob).claim(
                        bob.address,
                        [1],
                        1, // Reinvest
                        150
                    )

                addLiquidity(Math.floor(repaymentAmount * sharesBeforeLoanBob / sharesBeforeLoan), 'bob')

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        currentTotalLiquidity(), currentTotalShares(), REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        2, 2 + MIN_LPING_PERIOD, 1, [
                            sharesBeforeLoanAlice,
                            currentAliceShares
                        ], [2]
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        2, 2 + MIN_LPING_PERIOD, 1, [
                            sharesBeforeLoanBob,
                            currentBobShares
                        ], [2]
                    ]
                )

                await checkEvents(tx2, [
                    {
                        lp : bob.address,
                        repayments : repaymentBob,
                        newLpShares : currentBobShares - sharesBeforeClaimingBob,
                        earliestRemove : 2 + MIN_LPING_PERIOD,
                        loanIdx : 2
                    },
                    {
                        lp : bob.address,
                        loanIdxs : [1],
                        repayments : repaymentBob,
                        collateral : 0
                    }
                ])

                const totalExpectedLiquidity = 
                    liquidityAlice1 + liquidityBob1 + liquidityAlice2 + liquidityBob2 +
                    liquidityAlice3 + liquidityBob3 + liquidityAlice4 + liquidityBob4 -
                    loanAmount + repaymentAmount

                console.log('Expected liquidity:', totalExpectedLiquidity)
                console.log('Actual liquidity:', currentTotalLiquidity())

                await setTime(2 + MIN_LPING_PERIOD)

                // Check that percentage of shares is equal to percentage of liquidity
                const sharePercentageAlice = currentAliceShares / currentTotalShares()
                const sharePercentageBob = currentBobShares / currentTotalShares()
                const liquidityPercentageAlice = currentAliceLiquidity / currentTotalLiquidity()
                const liquidityPercentageBob = currentBobLiquidity / currentTotalLiquidity()

                console.log('Alice share percentage:', sharePercentageAlice)
                console.log('Alice liquidity percentage:', liquidityPercentageAlice)
                console.log('Bob share percentage:', sharePercentageBob)
                console.log('Bob liquidity percentage:', liquidityPercentageBob)

                const expectedAliceWithdrawal = Math.floor(sharePercentageAlice * (currentTotalLiquidity() - MIN_LIQUIDITY))
                // Due to rounding errors, Bob won't receive Math.floor(sharePercentageBob * (currentTotalLiquidity() - MIN_LIQUIDITY))
                // Instead, he will receive all the remaining funds (which is 1 more than what he would have actually received)
                const expectedBobWithdrawal = (currentTotalLiquidity() - MIN_LIQUIDITY) - expectedAliceWithdrawal

                const balanceBeforeRemoveAlice = Number(await loanCcyTokenContract.balanceOf(alice.address))

                await contract.connect(alice).removeLiquidity(alice.address, currentAliceShares)

                const balanceAfterRemoveAlice = Number(await loanCcyTokenContract.balanceOf(alice.address))
                expect(balanceAfterRemoveAlice - balanceBeforeRemoveAlice).to.be.equal(expectedAliceWithdrawal)

                const balanceBeforeRemoveBob = Number(await loanCcyTokenContract.balanceOf(bob.address))

                await contract.connect(bob).removeLiquidity(bob.address, currentBobShares)

                const balanceAfterRemoveBob = Number(await loanCcyTokenContract.balanceOf(bob.address))
                expect(balanceAfterRemoveBob - balanceBeforeRemoveBob).to.be.equal(expectedBobWithdrawal)
            })

            it('claims multiple repayments at once (without re-investment)', async function () {
                const [alice, bob, charlie] = await newUsers([ [LOAN_CCY_TOKEN, 6000] ], [[ LOAN_CCY_TOKEN, 2000]],  [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidityAlice = 6000
                const liquidityBob = 2000
                const liquidity = liquidityAlice + liquidityBob
                const collateralPledge = 500
                const sharesAlice = 1000 * liquidityAlice / MIN_LIQUIDITY
                const sharesBob = Math.floor(liquidityBob / liquidityAlice * sharesAlice)
                const shares = sharesAlice + sharesBob

                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582                
                const loanAmount2 = 418
                const repaymentAmount2 = 596

                const repaymentAlice = Math.floor((repaymentAmount + repaymentAmount2) * liquidityAlice / liquidity)
                const repaymentBob = Math.floor((repaymentAmount + repaymentAmount2) * liquidityBob / liquidity)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice) ,150,0)

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob) ,150,0)

                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(charlie).repay(
                    1,
                    charlie.address
                )


                await contract.connect(charlie).repay(
                    2,
                    charlie.address
                )

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1, 2],
                        0, // Don't reinvest
                        150
                    )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        loanIdxs : [1, 2],
                        repayments : repaymentAlice,
                        collateral : 0
                    }
                ])

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        3, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                const tx2 = await contract.connect(bob).claim(
                        bob.address,
                        [1, 2],
                        0, // Don't reinvest
                        150
                    )

                await checkEvents(tx2, [
                    {
                        lp : bob.address,
                        loanIdxs : [1, 2],
                        repayments : repaymentBob,
                        collateral : 0
                    }
                ])

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        3, MIN_LPING_PERIOD, 0, [sharesAlice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        3, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )
            })


            it('claims multiple repayments at once (with re-investment)', async function () {
                const [alice, bob, charlie] = await newUsers([ [LOAN_CCY_TOKEN, 6000] ], [[ LOAN_CCY_TOKEN, 2000]],  [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidityAlice = 6000
                const liquidityBob = 2000
                const liquidity = liquidityAlice + liquidityBob
                const collateralPledge = 500
                const sharesAlice = 1000 * liquidityAlice / MIN_LIQUIDITY
                const sharesBob = Math.floor(liquidityBob / liquidityAlice * sharesAlice)
                const shares = sharesAlice + sharesBob

                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582                
                const loanAmount2 = 418
                const repaymentAmount2 = 596

                const repaymentAlice = Math.floor((repaymentAmount + repaymentAmount2) * liquidityAlice / liquidity)
                const repaymentBob = Math.floor((repaymentAmount + repaymentAmount2) * liquidityBob / liquidity)

                const shares2Alice = Math.floor((repaymentAmount + repaymentAmount2) / (liquidity - loanAmount - loanAmount2) * sharesAlice)
                const shares2Bob = Math.floor((repaymentAmount + repaymentAmount2) / (liquidity - loanAmount - loanAmount2) * sharesBob)


                await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice) ,150,0)

                await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob) ,150,0)

                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(charlie).repay(
                    1,
                    charlie.address
                )

                console.log('Done first')

                await contract.connect(charlie).repay(
                    2,
                    charlie.address
                )

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1, 2],
                        1, // Reinvest
                        150
                    )

                await checkEvents(tx1, [
                    {
                        lp : alice.address,
                        repayments : repaymentAlice,
                        newLpShares : shares2Alice,
                        earliestRemove : 2 + MIN_LPING_PERIOD,
                        loanIdx : 3
                    },
                    {
                        lp : alice.address,
                        loanIdxs : [1, 2],
                        repayments : repaymentAlice,
                        collateral : 0
                    }
                ])

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2 + repaymentAlice, shares + shares2Alice, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        3, MIN_LPING_PERIOD + 2, 0, [sharesAlice + shares2Alice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [sharesBob], []
                    ]
                )

                const tx2 = await contract.connect(bob).claim(
                        bob.address,
                        [1, 2],
                        1, // Reinvest
                        150
                    )

                await checkEvents(tx2, [
                    {
                        lp : bob.address,
                        repayments : repaymentBob,
                        newLpShares : shares2Bob,
                        earliestRemove : 2 + MIN_LPING_PERIOD,
                        loanIdx : 3
                    },
                    {
                        lp : bob.address,
                        loanIdxs : [1, 2],
                        repayments : repaymentBob,
                        collateral : 0
                    }
                ])

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2 + repaymentAlice + repaymentBob, shares + shares2Alice + shares2Bob, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        3, MIN_LPING_PERIOD + 2, 0, [sharesAlice + shares2Alice], []
                    ]
                )
                await checkQuery('getLpInfo', [bob.address],
                    [
                        3, MIN_LPING_PERIOD + 2, 0, [sharesBob + shares2Bob], []
                    ]
                )
            })

            it('claims the collateral for a failed loan', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                // Cause the loan to expire
                await setTime(LOAN_TENOR + 2)

                const tx1 = await contract.connect(alice).claim(
                        alice.address,
                        [1],
                        0,
                        150
                    )

                await checkEvents(tx1, [{
                    lp : alice.address,
                    loanIdxs : [1],
                    repayments : 0,
                    collateral : collateralPledge
                }])

                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                expect(await collCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(collateralPledge))
            })

            it('claims for an authorized address', async function () {
                const [alice, bob, charlie] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]], [])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                const bits = approvalBits(['claim'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(charlie.address, bits)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(bob).repay(
                    1,
                    bob.address
                )

                const tx1 = await contract.connect(charlie).claim(
                        alice.address,
                        [1],
                        0,
                        150
                    )

                await checkEvents(tx1, [{
                    lp : alice.address,
                    loanIdxs : [1],
                    repayments : repaymentAmount,
                    collateral : 0
                }])
                expect(await loanCcyTokenContract.balanceOf(charlie.address)).to.be.deep.equal(String(repaymentAmount))
            })

            it('fails to claim without being authorized', async function () {
                const [alice, bob, charlie] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]], [])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                const bits = approvalBits(['repay', 'addLiquidity', 'removeLiquidity', 'forceRewardUpdate'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(charlie.address, bits)

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(bob).repay(
                    1,
                    bob.address
                )

                await expect(contract.connect(charlie).claim(
                        alice.address,
                        [1],
                        0,
                        150
                    )).to.be.revertedWith('Sender not approved.')
            })

            it('fails to claim the collateral of an active loan', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await expect(contract.connect(alice).claim(
                        alice.address,
                        [1],
                        0,
                        150
                    )).to.be.revertedWith('Cannot claim with unsettled loan.')
            })

            it('fails to claim the collateral of an invalid loan', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(bob).repay(
                    1,
                    bob.address
                )

                await expect(contract.connect(alice).claim(
                        alice.address,
                        [2],
                        0,
                        150
                )).to.be.revertedWith('Loan indexes with changing shares.')
            })

            it('fails to claim an already claimed loan', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582

                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)

                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )

                // The contract doesn't allow atomic borrow + repay
                await setTime(2)

                await contract.connect(bob).repay(
                    1,
                    bob.address
                )

                await contract.connect(alice).claim(
                        alice.address,
                        [1],
                        0,
                        150
                    )

                await expect(contract.connect(alice).claim(
                        alice.address,
                        [1],
                        0,
                        150
                    )).to.be.revertedWith('Unentitled from loan indices.')
            })
        })

        describe('Controller tests', function () {
            beforeEach(async function () {
                await setTime(0, controllerContract)
            })
            describe('depositVoteToken', function () {
                it('deposits the vote token', async function () {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000] ])
                    
                    const tx1 = await controllerContract.connect(alice).depositVoteToken(String(200))

                    await checkEvents(tx1, [{
                        account : alice.address,
                        amount : 200,
                        newBalance : 200,
                        newTotalSupply : 200,
                        subTimestamp: 0
                    }], controllerContract)

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('200')
                    expect(await controllerContract.numAccountSnapshots(alice.address)).to.be.deep.equal('1')
                    expect(await controllerContract.getAccountSnapshot(alice.address, 0)).to.be.deep.equal(
                        ['200', '0', '0']
                    )
                })
            })

            describe('withdrawVoteToken', function () {
                it('withdraws the vote token', async function() {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000] ])

                    await setTime(1, controllerContract)
                    
                    await controllerContract.connect(alice).depositVoteToken(String(200))

                    expect(await controllerContract.numAccountSnapshots(alice.address)).to.be.deep.equal('1')
                    expect(await controllerContract.getAccountSnapshot(alice.address, 0)).to.be.deep.equal(
                        ['200', '1', '0']
                    )

                    await setTime(19, controllerContract)

                    const tx1 = await controllerContract.connect(alice).withdrawVoteToken(String(50))

                    expect(await controllerContract.numAccountSnapshots(alice.address)).to.be.deep.equal('2')
                    expect(await controllerContract.getAccountSnapshot(alice.address, 0)).to.be.deep.equal(
                        ['200', '1', '0']
                    )
                    expect(await controllerContract.getAccountSnapshot(alice.address, 1)).to.be.deep.equal(
                        ['150', '19', '0']
                    )
                    
                    expect(await controllerContract.voteTokenBalance(alice.address)).to.be.deep.equal('150')
                    expect(await voteTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(1000 - 150))

                    await checkEvents(tx1, [
                        {
                            account : alice.address,
                            amount : 50,
                            newBalance : 150,
                            newTotalSupply : 150,
                            subTimestamp: 0
                        }
                    ], controllerContract)
                })

                it('fails to withdraw more than the balance', async function() {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await setTime(19, controllerContract)

                    await controllerContract.connect(alice).depositVoteToken(String(200))
                    await controllerContract.connect(bob).depositVoteToken(String(200))

                    await setTime(19, controllerContract)

                    expect(
                        controllerContract.connect(alice).withdrawVoteToken(String(201))
                    ).to.be.revertedWith('Not enough tokens.')
                })

                it('fails to withdraw zero tokens', async function() {
                    const [alice] = await newUsers([[VOTE_TOKEN, 1000]])

                    await setTime(19, controllerContract)

                    await controllerContract.connect(alice).depositVoteToken(String(200))

                    await setTime(19, controllerContract)

                    expect(
                        controllerContract.connect(alice).withdrawVoteToken(String(0))
                    ).to.be.revertedWith('Cannot make a zero-value withdraw.')
                })

                it('fails to withdraw too early', async function() {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000] ])

                    await setTime(1, controllerContract)

                    await controllerContract.connect(alice).depositVoteToken(String(200))
                    expect(await controllerContract.lastDepositTimestamp(alice.address)).to.be.deep.equal('1')

                    await setTime(9, controllerContract)

                    await expect(
                        controllerContract.connect(alice).withdrawVoteToken(String(50))
                    ).to.be.revertedWith('Too early to withdraw.')
                })
            })

            describe('createProposal', function () {
                it('creates a proposal', async function ()  {
                    const [alice] = await newUsers([])

                    const tx1 = await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    await checkEvents(tx1, [{
                        proposalIdx : 0,
                        creator : alice.address,
                        target : contract.address,
                        action : Actions.Pause,
                        deadline : 150
                    }], controllerContract)

                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Pause), '0', ZERO_ADDRESS, false, '150'], controllerContract)
                    expect(await controllerContract.numProposals()).to.be.deep.equal('1')
                })

                it('fails to create a proposal with an incorrect action id', async function ()  {
                    const [alice] = await newUsers([])

                    await expect(
                        controllerContract.connect(alice).createProposal(contract.address, 4, 150)
                    ).to.be.revertedWithoutReason()
                })

                it('fails to create a proposal with a deadline in the past', async function ()  {
                    const [alice] = await newUsers([])

                    await setTime(151, controllerContract)
                    await expect(
                        controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)
                    ).to.be.revertedWith('Deadline must not be before timestamp.')
                })
            })

            describe('voting', function() {
                it('votes on a proposal (without executing)', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    const tx1 = await controllerContract.connect(alice).vote(0)

                    await checkEvents(tx1, [{
                        proposalIdx : 0,
                        voter : alice.address,
                        votes : 100,
                        newTotalVotes : 100
                    }], controllerContract)

                    // Proposal received 100 votes and wasn't executed
                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Pause), '100', ZERO_ADDRESS, false, '150'], controllerContract)
                })

                it('votes on multiple proposals', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)
                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    const tx1 = await controllerContract.connect(alice).vote(0)

                    await checkEvents(tx1, [{
                        proposalIdx : 0,
                        voter : alice.address,
                        votes : 100,
                        newTotalVotes : 100
                    }], controllerContract)

                    const tx2 = await controllerContract.connect(alice).vote(1)

                    await checkEvents(tx2, [{
                        proposalIdx : 1,
                        voter : alice.address,
                        votes : 100,
                        newTotalVotes : 100
                    }], controllerContract)

                    // Proposals received 100 votes and weren't executed
                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Pause), '100', ZERO_ADDRESS, false, '150'], controllerContract)
                    await checkQuery('getProposal', [1], [contract.address, String(Actions.Pause), '100', ZERO_ADDRESS, false, '150'], controllerContract)
                })

                it('removes a vote on a proposal', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    await controllerContract.connect(alice).vote(0)
                    const tx1 = await controllerContract.connect(alice).removeVote(0)

                    await checkEvents(tx1, [{
                        proposalIdx : 0,
                        voter : alice.address,
                        votes : 100,
                        newTotalVotes : 0
                    }], controllerContract)

                    // Proposal received 0 votes and wasn't executed
                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Pause), '0', ZERO_ADDRESS, false, '150'], controllerContract)
                })

                it('votes, removes and re-votes', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    await controllerContract.connect(alice).vote(0)
                    await controllerContract.connect(alice).removeVote(0)
                    const tx1 = await controllerContract.connect(alice).vote(0)

                    await checkEvents(tx1, [{
                        proposalIdx : 0,
                        voter : alice.address,
                        votes : 100,
                        newTotalVotes : 100
                    }], controllerContract)

                    // Proposal received 100 votes and wasn't executed
                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Pause), '100', ZERO_ADDRESS, false, '150'], controllerContract)
                })

                it('votes and executes a pause', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Bob has 90% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    const tx1 = await controllerContract.connect(bob).vote(0)

                    await checkEvents(tx1, [
                        {
                            proposalIdx : 0,
                            voter : bob.address,
                            votes : 900,
                            newTotalVotes : 900
                        },
                        {
                            proposalIdx : 0,
                            totalVotes : 900,
                            voteTokenTotalSupply : 1000
                        }
                    ], controllerContract)

                    expect(await contract.paused()).to.be.deep.equal(true)

                    // Proposal received 900 votes and was executed
                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Pause), '900', ZERO_ADDRESS, true, '150'], controllerContract)
                })

                it('pauses and unpauses', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Bob has 90% of the voting power

                    // Pause
                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)
                    await controllerContract.connect(bob).vote(0)

                    expect(await contract.paused()).to.be.deep.equal(true)

                    // Unpause
                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Unpause, 150)
                    const tx1 = await controllerContract.connect(bob).vote(1)

                    await checkEvents(tx1, [
                        {
                            proposalIdx : 1,
                            voter : bob.address,
                            votes : 900,
                            newTotalVotes : 900
                        },
                        {
                            proposalIdx : 1,
                            totalVotes : 900,
                            voteTokenTotalSupply : 1000
                        }
                    ], controllerContract)

                    expect(await contract.paused()).to.be.deep.equal(false)
                    
                })

                it('removes a vote after executing', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Bob has 90% of the voting power

                    // Pause
                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)
                    await controllerContract.connect(bob).vote(0)

                    expect(await contract.paused()).to.be.deep.equal(true)

                    const tx1 = await controllerContract.connect(bob).removeVote(0)

                    await checkEvents(tx1, [{
                        proposalIdx : 0,
                        voter : bob.address,
                        votes : 900,
                        newTotalVotes : 0
                    }], controllerContract)
                    
                    expect(await controllerContract.numVotings(bob.address)).to.be.deep.equal('0')

                    // Proposal has 0 votes and was executed
                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Pause), '0', ZERO_ADDRESS, true, '150'], controllerContract)                    
                })

                it('withdraws after removing all votes', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Bob has 90% of the voting power

                    // Pause
                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)
                    await controllerContract.connect(bob).vote(0)

                    expect(await contract.paused()).to.be.deep.equal(true)

                    await controllerContract.connect(bob).removeVote(0)

                    const tx1 = await controllerContract.connect(bob).withdrawVoteToken(String(50))

                    await checkEvents(tx1, [
                        {
                            account : bob.address,
                            amount : 50,
                            newBalance : 850,
                            newTotalSupply : 950,
                            subTimestamp : 2
                        }
                    ], controllerContract)

                    expect(await voteTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(150))
                })

                it('fails to vote when having zero voting power', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    await expect(
                        controllerContract.connect(alice).vote(0)
                    ).to.be.revertedWith('No voting power.')
                })

                it('fails to vote multiple times', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    await controllerContract.connect(alice).vote(0)
                    await expect(
                        controllerContract.connect(alice).vote(0)
                    ).to.be.revertedWith('Already voted.')
                })

                it('fails to remove a vote without having ever voted', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    await expect(
                        controllerContract.connect(alice).removeVote(0)
                    ).to.be.revertedWith('Did not vote.')
                })

                it('fails to remove a vote multiple times', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    await controllerContract.connect(alice).vote(0)

                    // Remove once
                    await controllerContract.connect(alice).removeVote(0)

                    // Remove twice
                    await expect(
                        controllerContract.connect(alice).removeVote(0)
                    ).to.be.revertedWith('Did not vote.')
                })

                it('fails to vote on an executed proposal', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Bob has 90% of the voting power

                    // Pause
                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)
                    await controllerContract.connect(bob).vote(0)

                    expect(await contract.paused()).to.be.deep.equal(true)

                    await expect(
                        controllerContract.connect(alice).vote(0)
                    ).to.be.revertedWith('Proposal already executed.')
                })

                it('fails to vote on an expired proposal', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Bob has 90% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)

                    await setTime(151, controllerContract)

                    await expect(
                        controllerContract.connect(alice).vote(0)
                    ).to.be.revertedWith('Proposal expired.')
                })

                it('fails to withdraw when voting', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Bob has 90% of the voting power

                    // Create & vote
                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Pause, 150)
                    await controllerContract.connect(alice).vote(0)

                    await expect(
                        controllerContract.connect(alice).withdrawVoteToken(String(50))
                    ).to.be.revertedWith('Cannot withdraw when votes are active.')

                })

                it('fails to pause/unpause without being the controller', async function () {
                    const [alice] = await newUsers([])

                    await expect(
                        contract.connect(alice).pause()
                    ).to.be.revertedWith('Not the controller.')

                    await expect(
                        contract.connect(alice).unpause()
                    ).to.be.revertedWith('Not the controller.')
                })
            })
            describe('token snapshotting', function () {
                it('takes a first snapshot of a token', async function () {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000], [COLL_CCY_TOKEN, 1000]])
                    await setTime(19, controllerContract)
                    await controllerContract.connect(alice).depositVoteToken(String(50))

                    const tx1 = await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '100')

                    await checkEvents(tx1, [
                        {
                            tokenId : COLL_CCY_TOKEN,
                            tokenSnapshotIdx : 0,
                            voteTokenTotalSupply : 50,
                            collectedRevenue : 100,
                            subTimestamp : 1
                        }
                    ], controllerContract)

                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')
                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '100', '0', '19', '1'])
                })

                it('takes only one snapshot despite multiple revenue deposits', async function () {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000], [COLL_CCY_TOKEN, 1000]])
                    await setTime(19, controllerContract)
                    await controllerContract.connect(alice).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '25')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')
                    
                    await controllerContract.connect(alice).depositVoteToken(String(7))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '100')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('100')
                    
                    await setTime(118, controllerContract)
                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '200')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('300')

                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                })

                it('takes a second snapshot after enough time has passed', async function () {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000], [COLL_CCY_TOKEN, 1000]])
                    await setTime(19, controllerContract)
                    await controllerContract.connect(alice).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '25')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')
                    
                    await controllerContract.connect(alice).depositVoteToken(String(7))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '100')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('100')

                    await setTime(119, controllerContract)

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '1')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')

                    
                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('2')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 1)).to.be.deep.equal(['57', '101', '0', '119', '0'])
                })

                it('takes only one snapshot despite multiple revenue deposits and a force-snapshot-check', async function () {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000], [COLL_CCY_TOKEN, 1000]])
                    await setTime(19, controllerContract)
                    await controllerContract.connect(alice).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '25')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')
                    
                    await controllerContract.connect(alice).depositVoteToken(String(7))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '100')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('100')
                    
                    await setTime(118, controllerContract)
                    await controllerContract.connect(alice).forceTokenSnapshotCheck(COLL_CCY_TOKEN)

                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                })

                it('forces a second snapshot after enough time has passed', async function () {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000], [COLL_CCY_TOKEN, 1000]])
                    await setTime(19, controllerContract)
                    await controllerContract.connect(alice).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '25')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')
                    
                    await controllerContract.connect(alice).depositVoteToken(String(7))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '100')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('100')

                    await setTime(119, controllerContract)
                    await controllerContract.connect(alice).forceTokenSnapshotCheck(COLL_CCY_TOKEN)
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')

                    
                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('2')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 1)).to.be.deep.equal(['57', '100', '0', '119', '0'])
                })

                it('takes snapshots for multiple intertwined tokens', async function () {
                    const [alice] = await newUsers([ [VOTE_TOKEN, 1000], [LOAN_CCY_TOKEN, 1000], [COLL_CCY_TOKEN, 1000]])
                    await setTime(19, controllerContract)
                    await controllerContract.connect(alice).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '25')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')

                    await setTime(29, controllerContract)
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '14')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')
                    expect(await controllerContract.currentRevenue(LOAN_CCY_TOKEN)).to.be.deep.equal('0')


                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '14', '0', '29', '0'])

                    // Doesn't trigger anything
                    await controllerContract.connect(alice).depositVoteToken(String(7))

                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '14', '0', '29', '0'])

                    // Doesn't trigger anything
                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '100')
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '100')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('100')
                    expect(await controllerContract.currentRevenue(LOAN_CCY_TOKEN)).to.be.deep.equal('100')

                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '14', '0', '29', '0'])

                    // Late enough for COLL to trigger (but not LOAN)
                    await setTime(119, controllerContract)
                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '1')
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('0')
                    expect(await controllerContract.currentRevenue(LOAN_CCY_TOKEN)).to.be.deep.equal('102')

                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('2')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 1)).to.be.deep.equal(['57', '101', '0', '119', '0'])
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '14', '0', '29', '0'])

                    // Late enough for LOAN to trigger (but COLL has already been triggered)
                    await setTime(129, controllerContract)
                    await controllerContract.connect(alice).depositRevenue(COLL_CCY_TOKEN, '3')
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '5')
                    expect(await controllerContract.currentRevenue(COLL_CCY_TOKEN)).to.be.deep.equal('3')
                    expect(await controllerContract.currentRevenue(LOAN_CCY_TOKEN)).to.be.deep.equal('0')

                    expect(await controllerContract.numTokenSnapshots(COLL_CCY_TOKEN)).to.be.deep.equal('2')
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 0)).to.be.deep.equal(['50', '25', '0', '19', '1'])
                    expect(await controllerContract.getTokenSnapshot(COLL_CCY_TOKEN, 1)).to.be.deep.equal(['57', '101', '0', '119', '0'])
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('2')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '14', '0', '29', '0'])
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 1)).to.be.deep.equal(['57', '107', '0', '129', '1'])
                })
            })

            describe('claimToken', function () {
                it('claims individually', async function () {
                    const [alice, bob, charlie] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    await controllerContract.connect(charlie).depositVoteToken(String(450))
                    // Bob now owns 10%, Charlie 90%

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    // Snapshot has been taken
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['500', '2000', '0', '0', '2'])
                    expect(await controllerContract.getAccountSnapshot(bob.address, 0)).to.be.deep.equal(['50', '0', '0'])

                    // Bob claims
                    console.log('Checking before...')
                    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal('0')
                    const tx1 = await controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, 0)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 0, bob.address)).to.be.deep.equal(true)

                    await checkEvents(tx1, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : bob.address,
                            tokenSnapshotIdx : 0,
                            accountSnapshotIdx : 0,
                            amount : 200,
                            totalClaimedRevenue : 200
                        }
                    ], controllerContract)

                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(
                        ['500', '2000', '200', '0', '2']
                    )
                    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal('200')

                    // Charlie claims
                    const tx2 = await controllerContract.connect(charlie).claimToken(LOAN_CCY_TOKEN, 0, 0)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 0, charlie.address)).to.be.deep.equal(true)

                    await checkEvents(tx2, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : charlie.address,
                            tokenSnapshotIdx : 0,
                            accountSnapshotIdx : 0,
                            amount : 1800,
                            totalClaimedRevenue : 2000
                        }
                    ], controllerContract)

                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(
                        ['500', '2000', '2000', '0', '2']
                    )
                    expect(await loanCcyTokenContract.balanceOf(charlie.address)).to.be.deep.equal('1800')
                })

                it('keeps zero-supply revenue pending until a claimable snapshot is possible', async function () {
                    const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')

                    expect(await controllerContract.currentRevenue(LOAN_CCY_TOKEN)).to.be.deep.equal('2000')
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('0')

                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    expect(await controllerContract.getAccountSnapshot(bob.address, 0)).to.be.deep.equal(['50', '0', '1'])

                    await setTime(SNAPSHOT_TOKEN_EVERY, controllerContract)
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '3000')

                    expect(await controllerContract.currentRevenue(LOAN_CCY_TOKEN)).to.be.deep.equal('0')
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '5000', '0', '100', '0'])

                    const before = await loanCcyTokenContract.balanceOf(bob.address)
                    await controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, 0)
                    const after = await loanCcyTokenContract.balanceOf(bob.address)

                    expect(after.sub(before)).to.be.deep.equal(BigNumber.from('5000'))
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '5000', '5000', '100', '0'])
                })

                it('claims individually for multiple snapshots', async function () {
                    const [alice, bob, charlie] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    await controllerContract.connect(charlie).depositVoteToken(String(450))
                    // Bob now owns 10%, Charlie 90%

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    // Snapshot has been taken at time 0

                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(
                        ['500', '2000', '0', '0', '2']
                    )

                    await setTime(19, controllerContract)

                    await controllerContract.connect(bob).depositVoteToken(String(150))
                    await controllerContract.connect(charlie).depositVoteToken(String(350))
                    // Bob now owns 20%, Charlie 80%

                    await setTime(100, controllerContract)

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '3000')
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('2')

                    // Snapshot has been taken at time 100
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 1)).to.be.deep.equal(
                        ['1000', '3000', '0', '100', '0']
                    )

                    // Bob claims
                    const tx1 = await controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, 0)
                    console.log('Bob 0')
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 0, bob.address)).to.be.deep.equal(true)

                    await checkEvents(tx1, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : bob.address,
                            tokenSnapshotIdx : 0,
                            accountSnapshotIdx : 0,
                            amount : 200,
                            totalClaimedRevenue : 200
                        }
                    ], controllerContract)

                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(
                        ['500', '2000', '200', '0', '2']
                    )
                    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal('200')

                    // Charlie claims
                    const tx2 = await controllerContract.connect(charlie).claimToken(LOAN_CCY_TOKEN, 0, 0)
                    console.log('Charlie 0')
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 0, charlie.address)).to.be.deep.equal(true)

                    await checkEvents(tx2, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : charlie.address,
                            tokenSnapshotIdx : 0,
                            accountSnapshotIdx : 0,
                            amount : 1800,
                            totalClaimedRevenue : 2000
                        }
                    ], controllerContract)

                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(
                        ['500', '2000', '2000', '0', '2']
                    )
                    expect(await loanCcyTokenContract.balanceOf(charlie.address)).to.be.deep.equal('1800')

                    // Second snapshot claiming

                    // Bob claims
                    const tx3 = await controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 1, 1)
                    console.log('Bob 1')
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 1, bob.address)).to.be.deep.equal(true)

                    await checkEvents(tx3, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : bob.address,
                            tokenSnapshotIdx : 1,
                            accountSnapshotIdx : 1,
                            amount : 600,
                            totalClaimedRevenue : 600
                        }
                    ], controllerContract)

                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 1)).to.be.deep.equal(
                        ['1000', '3000', '600', '100', '0']
                    )
                    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(200 + 600))

                    // Charlie claims
                    const tx4 = await controllerContract.connect(charlie).claimToken(LOAN_CCY_TOKEN, 1, 1)
                    console.log('Charlie 1')
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 1, charlie.address)).to.be.deep.equal(true)

                    await checkEvents(tx4, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : charlie.address,
                            tokenSnapshotIdx : 1,
                            accountSnapshotIdx : 1,
                            amount : 2400,
                            totalClaimedRevenue : 3000
                        }
                    ], controllerContract)

                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 1)).to.be.deep.equal(
                        ['1000', '3000', '3000', '100', '0']
                    )
                    expect(await loanCcyTokenContract.balanceOf(charlie.address)).to.be.deep.equal(String(1800 + 2400))
                })


                it('fails to claim twice', async function () {
                    const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(bob).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    // Snapshot has been taken
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '2000', '0', '0', '1'])
                    expect(await controllerContract.getAccountSnapshot(bob.address, 0)).to.be.deep.equal(['50', '0', '0'])

                    // Bob claims
                    await controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, 0)

                    await expect(
                        controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, 0)
                    ).to.be.revertedWith('Already claimed.')
                    
                })

                it('fails to claim with an invalid token snapshot idx', async function () {
                    const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(bob).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    // Snapshot has been taken
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '2000', '0', '0', '1'])
                    expect(await controllerContract.getAccountSnapshot(bob.address, 0)).to.be.deep.equal(['50', '0', '0'])

                    await expect(
                        controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 1, 0)
                    ).to.be.revertedWith('Invalid token snapshot idx.')
                })

                it('fails to claim with an invalid account snapshot idx', async function () {
                    const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(bob).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    // Snapshot has been taken
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '2000', '0', '0', '1'])
                    expect(await controllerContract.getAccountSnapshot(bob.address, 0)).to.be.deep.equal(['50', '0', '0'])

                    await expect(
                        controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, 1)
                    ).to.be.revertedWith('Invalid account snapshot idx.')
                })

                it('fails to claim with an account snapshot idx after the snapshot', async function () {
                    const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(bob).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    // Snapshot has been taken
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '2000', '0', '0', '1'])
                    expect(await controllerContract.getAccountSnapshot(bob.address, 0)).to.be.deep.equal(['50', '0', '0'])

                    await setTime(100, controllerContract)
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')

                    // accountSnapshot 1 exists, but it's not the correct snapshotIdx for claiming tokenSnapshot=0
                    await expect(
                        controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, 1)
                    ).to.be.revertedWith('Invalid account snapshot idx.')
                })

                it('fails to claim with an account snapshot idx too much before the snapshot', async function () {
                    const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(bob).depositVoteToken(String(50))

                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    // Snapshot has been taken
                    expect(await controllerContract.numTokenSnapshots(LOAN_CCY_TOKEN)).to.be.deep.equal('1')
                    expect(await controllerContract.getTokenSnapshot(LOAN_CCY_TOKEN, 0)).to.be.deep.equal(['50', '2000', '0', '0', '1'])
                    expect(await controllerContract.getAccountSnapshot(bob.address, 0)).to.be.deep.equal(['50', '0', '0'])

                    // Deposit vote tokens again
                    await controllerContract.connect(bob).depositVoteToken(String(50))

                    await setTime(100, controllerContract)
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')


                    // accountSnapshot 0 exists, but it's not the correct snapshotIdx for claiming tokenSnapshot=1
                    await expect(
                        controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 1, 0)
                    ).to.be.revertedWith('Incorrect account snapshot idx.')
                })

                describe('claimToken edge cases', function () {
                    // r: deposit revenue
                    // v: deposit vote token
                    // |: increase the time

                    const setups: Array<[string, number, string]> = [
                        ['rvv|vv', -1, 'Invalid token snapshot idx.'],
                        ['vrv|vv', 0, 'Incorrect account snapshot idx.'],
                        ['vvr|vv', 1, 'Incorrect account snapshot idx.'],
                        ['vv|rvv', 1, 'Incorrect account snapshot idx.'],
                        ['vv|vrv', 2, 'Incorrect account snapshot idx.'],
                        ['vv|vvr', 3, 'Incorrect account snapshot idx.']
                    ]

                    for (const setup of setups) {
                        const [actions, correctIndex, failureMessage] = setup

                        it('tests with ' + actions, async function () {
                            const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]])

                            // @ts-ignore
                            for (const action of actions) {
                                if (action == 'r') {
                                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '1000')
                                } else if (action == 'v') {
                                    await controllerContract.connect(bob).depositVoteToken('1')
                                } else {
                                    await setTime(1, controllerContract)
                                }
                            }

                            for (let i = 0; i < 4; i++) {
                                if (i != correctIndex) {
                                    // Should fail
                                    console.log('Testing failure with', i)
                                    await expect(
                                        controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, i)
                                    ).to.be.revertedWith(failureMessage)
                                }
                            }

                            if (correctIndex != -1) {
                                // Should succeed
                                console.log('Testing success with', correctIndex)
                                await controllerContract.connect(bob).claimToken(LOAN_CCY_TOKEN, 0, correctIndex)
                            }
                        })
                    }
                })
            })

            describe('claimMultipleTokens', function () {
                it('claims multiple token snapshots', async function () {
                    const [alice, bob, charlie] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    await controllerContract.connect(charlie).depositVoteToken(String(450))
                    // Bob has 10%, Charlie has 90%

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    
                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [1], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(250))
                    await controllerContract.connect(charlie).depositVoteToken(String(250))
                    // Bob has 30%, Charlie has 70%

                    await setTime(100, controllerContract)

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '3000')

                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [2], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    await checkQuery('getAccountSnapshot', [bob.address, 1], [300, 0, 3], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 1], [700, 0, 4], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 1], [1000, 3000, 0, 100, 0], controllerContract)

                    // Bob claims
                    const tx1 = await controllerContract.connect(bob).claimMultiple(
                        [LOAN_CCY_TOKEN, LOAN_CCY_TOKEN],
                        [0, 1],
                        [0, 1]
                    )

                    await checkEvents(tx1, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : bob.address,
                            tokenSnapshotIdx : 0,
                            accountSnapshotIdx : 0,
                            amount : 200,
                            totalClaimedRevenue : 200
                        },
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : bob.address,
                            tokenSnapshotIdx : 1,
                            accountSnapshotIdx : 1,
                            amount : 900,
                            totalClaimedRevenue : 900
                        }
                    ], controllerContract)

                    // Charlie claims
                    const tx2 = await controllerContract.connect(charlie).claimMultiple(
                        [LOAN_CCY_TOKEN, LOAN_CCY_TOKEN],
                        [0, 1],
                        [0, 1]
                    )

                    await checkEvents(tx2, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : charlie.address,
                            tokenSnapshotIdx : 0,
                            accountSnapshotIdx : 0,
                            amount : 1800,
                            totalClaimedRevenue : 2000
                        },
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : charlie.address,
                            tokenSnapshotIdx : 1,
                            accountSnapshotIdx : 1,
                            amount : 2100,
                            totalClaimedRevenue : 3000
                        }
                    ], controllerContract)

                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [2], controllerContract)

                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 2000, 0, 2], controllerContract)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 0, bob.address)).to.be.deep.equal(true)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 0, charlie.address)).to.be.deep.equal(true)

                    await checkQuery('getAccountSnapshot', [bob.address, 1], [300, 0, 3], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 1], [700, 0, 4], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 1], [1000, 3000, 3000, 100, 0], controllerContract)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 1, bob.address)).to.be.deep.equal(true)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 1, charlie.address)).to.be.deep.equal(true)

                    const expectedBobAmount = 2000 * (50 / 500) + 3000 * (300 / 1000)
                    const expectedCharlieAmount = 2000 * (450 / 500) + 3000 * (700 / 1000)
                    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(expectedBobAmount))
                    expect(await loanCcyTokenContract.balanceOf(charlie.address)).to.be.deep.equal(String(expectedCharlieAmount))
                })

                it('claims multiple token snapshots using 1-length arrays', async function () {
                    const [alice, bob, charlie] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    await controllerContract.connect(charlie).depositVoteToken(String(450))
                    // Bob has 10%, Charlie has 90%

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    
                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [1], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(250))
                    await controllerContract.connect(charlie).depositVoteToken(String(250))
                    // Bob has 30%, Charlie has 70%

                    await setTime(100, controllerContract)

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '3000')

                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [2], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    await checkQuery('getAccountSnapshot', [bob.address, 1], [300, 0, 3], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 1], [700, 0, 4], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 1], [1000, 3000, 0, 100, 0], controllerContract)

                    // Bob claims the first
                    const tx1 = await controllerContract.connect(bob).claimMultiple(
                        [LOAN_CCY_TOKEN],
                        [0],
                        [0]
                    )
                    

                    await checkEvents(tx1, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : bob.address,
                            tokenSnapshotIdx : 0,
                            accountSnapshotIdx : 0,
                            amount : 200,
                            totalClaimedRevenue : 200
                        }
                    ], controllerContract)

                    // Charlie claims the first
                    const tx2 = await controllerContract.connect(charlie).claimMultiple(
                        [LOAN_CCY_TOKEN],
                        [0],
                        [0]
                    )

                    await checkEvents(tx2, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : charlie.address,
                            tokenSnapshotIdx : 0,
                            accountSnapshotIdx : 0,
                            amount : 1800,
                            totalClaimedRevenue : 2000
                        }
                    ], controllerContract)

                    // Bob claims the second
                    const tx3 = await controllerContract.connect(bob).claimMultiple(
                        [LOAN_CCY_TOKEN],
                        [1],
                        [1]
                    )
                    

                    await checkEvents(tx3, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : bob.address,
                            tokenSnapshotIdx : 1,
                            accountSnapshotIdx : 1,
                            amount : 900,
                            totalClaimedRevenue : 900
                        }
                    ], controllerContract)

                    // Charlie claims the second
                    const tx4 = await controllerContract.connect(charlie).claimMultiple(
                        [LOAN_CCY_TOKEN],
                        [1],
                        [1]
                    )

                    await checkEvents(tx4, [
                        {
                            tokenId : LOAN_CCY_TOKEN,
                            account : charlie.address,
                            tokenSnapshotIdx : 1,
                            accountSnapshotIdx : 1,
                            amount : 2100,
                            totalClaimedRevenue : 3000
                        }
                    ], controllerContract)

                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [2], controllerContract)

                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 2000, 0, 2], controllerContract)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 0, bob.address)).to.be.deep.equal(true)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 0, charlie.address)).to.be.deep.equal(true)

                    await checkQuery('getAccountSnapshot', [bob.address, 1], [300, 0, 3], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 1], [700, 0, 4], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 1], [1000, 3000, 3000, 100, 0], controllerContract)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 1, bob.address)).to.be.deep.equal(true)
                    expect(await controllerContract.hasClaimedSnapshot(LOAN_CCY_TOKEN, 1, charlie.address)).to.be.deep.equal(true)

                    const expectedBobAmount = 2000 * (50 / 500) + 3000 * (300 / 1000)
                    const expectedCharlieAmount = 2000 * (450 / 500) + 3000 * (700 / 1000)
                    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(expectedBobAmount))
                    expect(await loanCcyTokenContract.balanceOf(charlie.address)).to.be.deep.equal(String(expectedCharlieAmount))
                })

                it('fails to claim with incorrect param lengths', async function () {
                    const [alice, bob, charlie] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    await controllerContract.connect(charlie).depositVoteToken(String(450))
                    // Bob has 10%, Charlie has 90%

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    
                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [1], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(250))
                    await controllerContract.connect(charlie).depositVoteToken(String(250))
                    // Bob has 30%, Charlie has 70%

                    await setTime(100, controllerContract)

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '3000')

                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [2], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    await checkQuery('getAccountSnapshot', [bob.address, 1], [300, 0, 3], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 1], [700, 0, 4], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 1], [1000, 3000, 0, 100, 0], controllerContract)

                    // Too many token ids
                    await expect(
                        controllerContract.connect(bob).claimMultiple(
                            [LOAN_CCY_TOKEN, LOAN_CCY_TOKEN, LOAN_CCY_TOKEN],
                            [0, 1],
                            [0, 1]
                        )
                    ).to.be.revertedWith('_tokens and _tokenSnapshotIdxs must have the same length.')

                    // Too many account snapshot idxs
                    await expect(
                        controllerContract.connect(bob).claimMultiple(
                            [LOAN_CCY_TOKEN, LOAN_CCY_TOKEN],
                            [0, 1, 1],
                            [0, 1]
                        )
                    ).to.be.revertedWith('_tokens and _tokenSnapshotIdxs must have the same length.')

                    // Too many token snapshot idxs
                    await expect(
                        controllerContract.connect(bob).claimMultiple(
                            [LOAN_CCY_TOKEN, LOAN_CCY_TOKEN],
                            [0, 1],
                            [0, 1, 1]
                        )
                    ).to.be.revertedWith('_tokens and _accountSnapshotIdxs must have the same length.')
                })

                it('fails to claim a token multiple times in the same transaction', async function () {
                    const [alice, bob, charlie] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    await controllerContract.connect(charlie).depositVoteToken(String(450))
                    // Bob has 10%, Charlie has 90%

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    
                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [1], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(250))
                    await controllerContract.connect(charlie).depositVoteToken(String(250))
                    // Bob has 30%, Charlie has 70%

                    await setTime(100, controllerContract)

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '3000')

                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [2], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    await checkQuery('getAccountSnapshot', [bob.address, 1], [300, 0, 3], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 1], [700, 0, 4], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 1], [1000, 3000, 0, 100, 0], controllerContract)

                    // Try to claim the second token twice
                    await expect(
                            controllerContract.connect(bob).claimMultiple(
                            [LOAN_CCY_TOKEN, LOAN_CCY_TOKEN, LOAN_CCY_TOKEN],
                            [0, 1, 1],
                            [0, 1, 1]
                        )
                    ).to.be.revertedWith('Already claimed.')
                })

                it('fails to claim a token with a zero-length parameter', async function () {
                    const [alice, bob, charlie] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    await controllerContract.connect(charlie).depositVoteToken(String(450))
                    // Bob has 10%, Charlie has 90%

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    
                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [1], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(250))
                    await controllerContract.connect(charlie).depositVoteToken(String(250))
                    // Bob has 30%, Charlie has 70%

                    await setTime(100, controllerContract)

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '3000')

                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [2], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    await checkQuery('getAccountSnapshot', [bob.address, 1], [300, 0, 3], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 1], [700, 0, 4], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 1], [1000, 3000, 0, 100, 0], controllerContract)

                    // Try to claim with a zero-length parameter
                    await expect(
                            controllerContract.connect(bob).claimMultiple(
                            [],
                            [],
                            []
                        )
                    ).to.be.revertedWith('Arrays must have at least one element.')
                })

                it('fails to claim multiple token snapshots if one is incorrect', async function () {
                    const [alice, bob, charlie] = await newUsers([[LOAN_CCY_TOKEN, 10000]], [[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(50))
                    await controllerContract.connect(charlie).depositVoteToken(String(450))
                    // Bob has 10%, Charlie has 90%

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '2000')
                    
                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [1], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    // Take a voteToken snapshot
                    await controllerContract.connect(bob).depositVoteToken(String(250))
                    await controllerContract.connect(charlie).depositVoteToken(String(250))
                    // Bob has 30%, Charlie has 70%

                    await setTime(100, controllerContract)

                    // Take a token snapshot
                    await controllerContract.connect(alice).depositRevenue(LOAN_CCY_TOKEN, '3000')

                    await checkQuery('numTokenSnapshots', [LOAN_CCY_TOKEN], [2], controllerContract)
                    await checkQuery('getAccountSnapshot', [bob.address, 0], [50, 0, 0], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 0], [450, 0, 1], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 0], [500, 2000, 0, 0, 2], controllerContract)

                    await checkQuery('getAccountSnapshot', [bob.address, 1], [300, 0, 3], controllerContract)
                    await checkQuery('getAccountSnapshot', [charlie.address, 1], [700, 0, 4], controllerContract)
                    await checkQuery('getTokenSnapshot', [LOAN_CCY_TOKEN, 1], [1000, 3000, 0, 100, 0], controllerContract)

                    await expect(
                        controllerContract.connect(bob).claimMultiple(
                            [LOAN_CCY_TOKEN, LOAN_CCY_TOKEN],
                            [0, 1],
                            [1, 1] // Account snapshot 0 is the incorrect snapshot to claim token snapshot 1
                        )
                    ).to.be.revertedWith('Incorrect account snapshot idx.')

                    await expect(
                        controllerContract.connect(charlie).claimMultiple(
                            [LOAN_CCY_TOKEN, LOAN_CCY_TOKEN],
                            [0, 1],
                            [1, 1] // Account snapshot 0 is the incorrect snapshot to claim token snapshot 1
                        )
                    ).to.be.revertedWith('Incorrect account snapshot idx.')

                    // Check that no money was actually disbursed
                    expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal('0')
                    expect(await loanCcyTokenContract.balanceOf(charlie.address)).to.be.deep.equal('0')
                })
            })

            describe('voteToken reward deposit', function () {
                it('deposits the voteToken for rewards', async function () {
                    const [alice] = await newUsers([[VOTE_TOKEN, 1000]])

                    await checkQuery('rewardSupply', [], [String(0)], controllerContract)
                    await controllerContract.connect(alice).depositRewardSupply('1000')
                    await checkQuery('rewardSupply', [], [String(1000)], controllerContract)
                })

                it('fails to deposit the wrong token for rewards', async function () {
                    const [alice] = await newUsers([[LOAN_CCY_TOKEN, 1000]])

                    await expect(
                        controllerContract.connect(alice).depositRewardSupply('1000')
                    ).to.be.revertedWith('ERC20: insufficient allowance')
                })
            })

            describe('reward collection', function () {
                it('collects the reward (without depositing)', async function () {
                    const [alice, bob, charlie, dan] = await newUsers([[VOTE_TOKEN, 20000000]], [[VOTE_TOKEN, 1000]], [], [])
                    
                    await controllerContract.connect(alice).depositRewardSupply('10000000')

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(charlie.address, Actions.Whitelist, 150)

                    await checkQuery('poolWhitelisted', [charlie.address], [false], controllerContract)

                    await controllerContract.connect(alice).vote(0)
                    await controllerContract.connect(bob).vote(0)

                    // Not yet executed: the veto holder hasn't set its approval
                    await checkQuery('poolWhitelisted', [charlie.address], [false], controllerContract)

                    await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

                    await checkQuery('poolWhitelisted', [charlie.address], [true], controllerContract)

                    // Charlie is now a whitelisted pool. Request sending some tokens to Dan
                    const liquidity = 452
                    const duration = 3691
                    const rewardCoefficient = MONE.mul(135).div(100).toString() // 1.35
                    const reward = 2252248 // Precomputed

                    const tx1 = await controllerContract.connect(charlie).requestTokenDistribution(dan.address, liquidity, duration, rewardCoefficient)

                    await checkQuery('rewardSupply', [], [String(10000000 - reward)], controllerContract)
                    
                    await checkEvents(tx1, [{
                        account : dan.address,
                        liquidity,
                        duration,
                        rewardCoefficient,
                        amount : reward
                    }], controllerContract)

                    await checkQuery('rewardBalance', [dan.address], [reward], controllerContract)

                    await controllerContract.connect(dan).collectReward(false)
                    expect(await voteTokenContract.balanceOf(dan.address)).to.be.deep.equal(String(reward))
                })

                it('collects the reward (with depositing)', async function () {
                    const [alice, bob, charlie, dan] = await newUsers([[VOTE_TOKEN, 20000000]], [[VOTE_TOKEN, 1000]], [], [])
                    
                    await controllerContract.connect(alice).depositRewardSupply('10000000')

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(charlie.address, Actions.Whitelist, 150)

                    await checkQuery('poolWhitelisted', [charlie.address], [false], controllerContract)

                    await controllerContract.connect(alice).vote(0)
                    await controllerContract.connect(bob).vote(0)

                    // Not yet executed: the veto holder hasn't set its approval
                    await checkQuery('poolWhitelisted', [charlie.address], [false], controllerContract)

                    await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

                    await checkQuery('poolWhitelisted', [charlie.address], [true], controllerContract)

                    // Charlie is now a whitelisted pool. Request sending some tokens to Dan
                    const liquidity = 452
                    const duration = 3691
                    const rewardCoefficient = MONE.mul(135).div(100).toString() // 1.35
                    const reward = 2252248 // Precomputed

                    const tx1 = await controllerContract.connect(charlie).requestTokenDistribution(dan.address, liquidity, duration, rewardCoefficient)

                    await checkQuery('rewardSupply', [], [String(10000000 - reward)], controllerContract)
                    
                    await checkEvents(tx1, [{
                        account : dan.address,
                        liquidity,
                        duration,
                        rewardCoefficient,
                        amount : reward
                    }], controllerContract)

                    await checkQuery('rewardBalance', [dan.address], [reward], controllerContract)

                    await setTime(123, controllerContract)

                    const tx2 = await controllerContract.connect(dan).collectReward(true)
                    expect(await voteTokenContract.balanceOf(dan.address)).to.be.deep.equal(String(0))
                    await checkQuery('voteTokenBalance', [dan.address], [reward], controllerContract)
                    await checkQuery('lastDepositTimestamp', [dan.address], [123], controllerContract)

                    await checkEvents(tx2, [{
                        account : dan.address,
                        amount : reward,
                        newBalance : reward,
                        newTotalSupply : 100 + 900 + reward,
                        subTimestamp: 0
                    }], controllerContract)
                })

                it('fails to collect the reward when there is none', async function () {
                    const [alice] = await newUsers([])
                    await expect(
                        controllerContract.connect(alice).collectReward(true)
                    ).to.be.revertedWith('No reward to collect.')
                })
            })

            describe('veto power transfer', function () {
                it('transfers the veto power to someone else', async function () {
                    const [alice] = await newUsers([])

                    await checkQuery('vetoHolder', [], [deployer.address], controllerContract)
                    const tx1 = await controllerContract.connect(deployer).transferVetoPower(alice.address, false)
                    await checkQuery('vetoHolder', [], [alice.address], controllerContract)

                    await checkEvents(tx1, [{
                        oldHolder: deployer.address,
                        newHolder : alice.address
                    }], controllerContract)
                })

                it('transfers the veto power to the zero address', async function () {
                    await checkQuery('vetoHolder', [], [deployer.address], controllerContract)
                    const tx1 = await controllerContract.connect(deployer).transferVetoPower(ZERO_ADDRESS, true)
                    await checkQuery('vetoHolder', [], [ZERO_ADDRESS], controllerContract)

                    await checkEvents(tx1, [{
                        oldHolder: deployer.address,
                        newHolder : ZERO_ADDRESS
                    }], controllerContract)
                })

                it('fails to transfer the veto power without being the holder', async function () {
                    const [alice, bob] = await newUsers([], [])

                    await expect(
                        controllerContract.connect(alice).transferVetoPower(bob.address, false)
                    ).to.be.revertedWith('Not the veto holder.')
                })

                it('fails to transfer the veto power to itself', async function () {
                    await expect(
                        controllerContract.connect(deployer).transferVetoPower(deployer.address, false)
                    ).to.be.revertedWith('Already the veto holder.')
                })

                it('fails to transfer the veto power to the zero address without the correct flag', async function () {
                    await expect(
                        controllerContract.connect(deployer).transferVetoPower(ZERO_ADDRESS, false)
                    ).to.be.revertedWith('Transfer to the zero address.')
                })
            })

            describe('setVetoHolderApproval', function () {
                it('approves a whitelist proposal', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Whitelist, 150)

                    const tx1 = await controllerContract.connect(deployer).setVetoHolderApproval(0, true)
                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Whitelist), '0', deployer.address, false, '150'], controllerContract)
                    
                    await checkEvents(tx1, [
                        {
                            proposalIdx : 0,
                            approved: true
                        }
                    ], controllerContract)
                })

                it('approves and de-approves a whitelist proposal', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Whitelist, 150)

                    const tx1 = await controllerContract.connect(deployer).setVetoHolderApproval(0, true)
                    await checkQuery('getProposal', [0], [contract.address, String(Actions.Whitelist), '0', deployer.address, false, '150'], controllerContract)

                    await checkEvents(tx1, [
                        {
                            proposalIdx : 0,
                            approved: true
                        }
                    ], controllerContract)

                    const tx2 = await controllerContract.connect(deployer).setVetoHolderApproval(0, false)

                    await checkEvents(tx2, [
                        {
                            proposalIdx : 0,
                            approved: false
                        }
                    ], controllerContract)
                })

                it('fails to approve a non-existent proposal', async function () {
                    await expect(
                        controllerContract.connect(deployer).setVetoHolderApproval(0, true)
                    ).to.be.revertedWith('Invalid proposal idx.')
                })

                it('fails to approve without being the veto holder', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Whitelist, 150)

                    await expect(
                        controllerContract.connect(alice).setVetoHolderApproval(0, true)
                    ).to.be.revertedWith('Not the veto holder.')
                })

                it('fails to approve a non-whitelist proposal', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Dewhitelist, 150)

                    await expect(
                        controllerContract.connect(deployer).setVetoHolderApproval(0, true)
                    ).to.be.revertedWith('Not a whitelist proposal.')
                })

                it('fails to de-approve an executed proposal', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Whitelist, 150)

                    await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

                    await controllerContract.connect(alice).vote(0)
                    await controllerContract.connect(bob).vote(0)

                    
                    await expect(
                        controllerContract.connect(deployer).setVetoHolderApproval(0, true)
                    ).to.be.revertedWith('Proposal already executed.')
                })
            })

            describe('whitelisting', function () {
                it('whitelists a pool', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Whitelist, 150)

                    await checkQuery('poolWhitelisted', [contract.address], [false], controllerContract)

                    await controllerContract.connect(alice).vote(0)
                    await controllerContract.connect(bob).vote(0)

                    // Not yet executed: the veto holder hasn't set its approval
                    await checkQuery('poolWhitelisted', [contract.address], [false], controllerContract)

                    const tx1 = await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

                    await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)

                    await checkEvents(tx1, [
                        {
                            proposalIdx : 0,
                            approved: true
                        },
                        {
                            proposalIdx : 0,
                            totalVotes : 1000,
                            voteTokenTotalSupply : 1000
                        }
                    ], controllerContract)
                })

                it('whitelists a pool (with approval before votes)', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Whitelist, 150)

                    const tx1 = await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

                    await checkEvents(tx1, [
                        {
                            proposalIdx : 0,
                            approved: true
                        }
                    ], controllerContract)

                    // Not yet executed: the proposal hasn't passed yet
                    await checkQuery('poolWhitelisted', [contract.address], [false], controllerContract)

                    await controllerContract.connect(alice).vote(0)
                    const tx2 = await controllerContract.connect(bob).vote(0)


                    await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)

                    await checkEvents(tx2, [
                        {
                            proposalIdx : 0,
                            voter : bob.address,
                            votes : 900,
                            newTotalVotes : 1000
                        },
                        {
                            proposalIdx : 0,
                            totalVotes : 1000,
                            voteTokenTotalSupply : 1000
                        }
                    ], controllerContract)
                })

                it('whitelists & de-whitelists a pool', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Whitelist, 150)

                    await checkQuery('poolWhitelisted', [contract.address], [false], controllerContract)

                    await controllerContract.connect(alice).vote(0)
                    await controllerContract.connect(bob).vote(0)

                    // Not yet executed: the veto holder hasn't set its approval
                    await checkQuery('poolWhitelisted', [contract.address], [false], controllerContract)

                    const tx1 = await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

                    await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)

                    await checkEvents(tx1, [
                        {
                            proposalIdx : 0,
                            approved: true
                        },
                        {
                            proposalIdx : 0,
                            totalVotes : 1000,
                            voteTokenTotalSupply : 1000
                        }
                    ], controllerContract)

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Dewhitelist, 150)

                    await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)

                    await controllerContract.connect(alice).vote(1)
                    const tx2 = await controllerContract.connect(bob).vote(1)

                    await checkQuery('poolWhitelisted', [contract.address], [false], controllerContract)

                    await checkEvents(tx2, [
                        {
                            proposalIdx : 1,
                            voter : bob.address,
                            votes : 900,
                            newTotalVotes : 1000
                        },
                        {
                            proposalIdx : 1,
                            totalVotes : 1000,
                            voteTokenTotalSupply : 1000
                        }
                    ], controllerContract)
                })

                it('whitelists a pool (with a zero-address veto holder)', async function () {
                    const [alice, bob] = await newUsers([[VOTE_TOKEN, 1000]], [[VOTE_TOKEN, 1000]])

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Transfer veto power to the zero address
                    await checkQuery('vetoHolder', [], [deployer.address], controllerContract)
                    await controllerContract.connect(deployer).transferVetoPower(ZERO_ADDRESS, true)
                    await checkQuery('vetoHolder', [], [ZERO_ADDRESS], controllerContract)

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(contract.address, Actions.Whitelist, 150)

                    await checkQuery('poolWhitelisted', [contract.address], [false], controllerContract)

                    await controllerContract.connect(alice).vote(0)
                    const tx1 = await controllerContract.connect(bob).vote(0)

                    // Approval is not required, so it is immediately executed
                    await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)

                    await checkEvents(tx1, [
                        {
                            proposalIdx : 0,
                            voter : bob.address,
                            votes : 900,
                            newTotalVotes : 1000
                        },
                        {
                            proposalIdx : 0,
                            totalVotes : 1000,
                            voteTokenTotalSupply : 1000
                        }
                    ], controllerContract)
                })
            })

            describe('token distribution', function () {
                it('requests token distribution for an address', async function () {
                    const [alice, bob, charlie, dan] = await newUsers([[VOTE_TOKEN, 20000000]], [[VOTE_TOKEN, 1000]], [], [])
                    
                    await controllerContract.connect(alice).depositRewardSupply('10000000')

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(charlie.address, Actions.Whitelist, 150)

                    await checkQuery('poolWhitelisted', [charlie.address], [false], controllerContract)

                    await controllerContract.connect(alice).vote(0)
                    await controllerContract.connect(bob).vote(0)

                    // Not yet executed: the veto holder hasn't set its approval
                    await checkQuery('poolWhitelisted', [charlie.address], [false], controllerContract)

                    await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

                    await checkQuery('poolWhitelisted', [charlie.address], [true], controllerContract)

                    // Charlie is now a whitelisted pool. Request sending some tokens to Dan
                    const liquidity = 452
                    const duration = 3691
                    const rewardCoefficient = MONE.mul(135).div(100).toString() // 1.35
                    const reward = 2252248 // Precomputed

                    const tx1 = await controllerContract.connect(charlie).requestTokenDistribution(dan.address, liquidity, duration, rewardCoefficient)

                    await checkQuery('rewardSupply', [], [String(10000000 - reward)], controllerContract)
                    
                    await checkEvents(tx1, [{
                        account : dan.address,
                        liquidity,
                        duration,
                        rewardCoefficient,
                        amount : reward
                    }], controllerContract)
                    await checkQuery('rewardBalance', [dan.address], [reward], controllerContract)
                })

                it('fails to request token distribution without being whitelisted', async function () {
                    const [alice, charlie, dan] = await newUsers([[VOTE_TOKEN, 20000000]], [], [])
                    
                    await controllerContract.connect(alice).depositRewardSupply('10000000')

                    const liquidity = 452
                    const duration = 3691
                    const rewardCoefficient = MONE.mul(135).div(100).toString() // 1.35
                    const reward = 2252248 // Precomputed

                    await expect(
                        controllerContract.connect(charlie).requestTokenDistribution(
                            dan.address, liquidity, duration, rewardCoefficient
                        )
                    ).to.be.revertedWith('Pool is not whitelisted.')
                })

                it('receives a partial token distribution when there are not enough tokens', async function () {
                    const [alice, bob, charlie, dan] = await newUsers([[VOTE_TOKEN, 20000000]], [[VOTE_TOKEN, 1000]], [], [])
                    
                    // 1M instead of 10M
                    await controllerContract.connect(alice).depositRewardSupply('1000000')

                    await controllerContract.connect(alice).depositVoteToken(String(100))
                    await controllerContract.connect(bob).depositVoteToken(String(900))

                    expect(await controllerContract.voteTokenTotalSupply()).to.be.deep.equal('1000')

                    // Alice has 10% of the voting power

                    await controllerContract.connect(alice).createProposal(charlie.address, Actions.Whitelist, 150)

                    await checkQuery('poolWhitelisted', [charlie.address], [false], controllerContract)

                    await controllerContract.connect(alice).vote(0)
                    await controllerContract.connect(bob).vote(0)

                    // Not yet executed: the veto holder hasn't set its approval
                    await checkQuery('poolWhitelisted', [charlie.address], [false], controllerContract)

                    await controllerContract.connect(deployer).setVetoHolderApproval(0, true)

                    await checkQuery('poolWhitelisted', [charlie.address], [true], controllerContract)

                    // Charlie is now a whitelisted pool. Request sending some tokens to Dan
                    const liquidity = 452
                    const duration = 3691
                    const rewardCoefficient = MONE.mul(135).div(100).toString() // 1.35

                    await controllerContract.connect(charlie).requestTokenDistribution(
                        dan.address, liquidity, duration, rewardCoefficient
                    )

                    await checkQuery('rewardBalance', [dan.address], ['1000000'], controllerContract)
                })
            })
        })

        describe('MultiClaim', function () {
            it('checks that MultiClaim is equivalent to multiple claims', async function () {
                await setTime(0, contract)
                const multiclaimContract = await multiclaimContractBlueprint.deploy()
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 12000], [COLL_CCY_TOKEN, 8000]])

                const bits = approvalBits(['addLiquidity', 'claim'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(multiclaimContract.address, bits)
    
                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
    
                const loanAmount2 = 418
                const repaymentAmount2 = 596
    
                const shares2 = Math.floor(repaymentAmount / (liquidity - loanAmount - loanAmount2) * shares)
    
                // Note that although claiming the second loan is done after claimining the first loan, the liqudiity isn't
                // already updated with repaymentAmount. That's because the contract first computes all the repayments and
                // then deposits the new liquidity at the end
                const shares3 = Math.floor(repaymentAmount2 / (liquidity - loanAmount - loanAmount2) * (shares))
    
                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                // The contract doesn't allow atomic borrow + repay
                await setTime(2)
    
                await contract.connect(bob).repay(
                    1,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).repay(
                    2,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                const tx1 = await multiclaimContract.connect(alice).claimMultiple(
                        contract.address,
                        [[1, 2]],
                        [1], // Reinvest
                        150
                    )
    
                // The liquidity and shares don't change because the user didn't reinvest
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2 + repaymentAmount + repaymentAmount2, shares + shares2 + shares3, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        3, 2 + MIN_LPING_PERIOD, 0, [shares + shares2 + shares3], []
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(8000 - liquidity))
            })

            it('checks that MultiClaim (used with singleton arrays) is equivalent to multiple claims', async function () {
                await setTime(0, contract)
                const multiclaimContract = await multiclaimContractBlueprint.deploy()
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 12000], [COLL_CCY_TOKEN, 8000]])

                const bits = approvalBits(['addLiquidity', 'claim'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(multiclaimContract.address, bits)
    
                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
    
                const loanAmount2 = 418
                const repaymentAmount2 = 596
    
                const shares2 = Math.floor(repaymentAmount / (liquidity - loanAmount - loanAmount2) * shares)
    
                // Note that although claiming the second loan is done after claimining the first loan, the liqudiity isn't
                // already updated with repaymentAmount. That's because the contract first computes all the repayments and
                // then deposits the new liquidity at the end
                const shares3 = Math.floor(repaymentAmount2 / (liquidity - loanAmount - loanAmount2) * (shares))
    
                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                // The contract doesn't allow atomic borrow + repay
                await setTime(2)
    
                await contract.connect(bob).repay(
                    1,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).repay(
                    2,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                const tx1 = await multiclaimContract.connect(alice).claimMultiple(
                        contract.address,
                        [[1], [2]],
                        [1, 1], // Reinvest
                        150
                    )
    
                // The liquidity and shares don't change because the user didn't reinvest
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2 + repaymentAmount + repaymentAmount2, shares + shares2 + shares3, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        3, 2 + MIN_LPING_PERIOD, 1, [shares, shares + shares2 + shares3], [3]
                    ]
                )
                expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(8000 - liquidity))
            })

            it('fails to claim a loan with mismatched sizes', async function () {
                await setTime(0, contract)
                const multiclaimContract = await multiclaimContractBlueprint.deploy()
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 12000], [COLL_CCY_TOKEN, 8000]])

                const bits = approvalBits(['addLiquidity', 'claim'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(multiclaimContract.address, bits)
    
                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
    
                const loanAmount2 = 418
                const repaymentAmount2 = 596
    
                const shares2 = Math.floor(repaymentAmount / (liquidity - loanAmount - loanAmount2) * shares)
    
                // Note that although claiming the second loan is done after claimining the first loan, the liqudiity isn't
                // already updated with repaymentAmount. That's because the contract first computes all the repayments and
                // then deposits the new liquidity at the end
                const shares3 = Math.floor(repaymentAmount2 / (liquidity - loanAmount - loanAmount2) * (shares))
    
                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                // The contract doesn't allow atomic borrow + repay
                await setTime(2)
    
                await contract.connect(bob).repay(
                    1,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).repay(
                    2,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                await expect(
                    multiclaimContract.connect(alice).claimMultiple(
                        contract.address,
                        [[1, 2]],
                        [1, 1], // Reinvest
                        150
                    )
                ).to.be.revertedWith('MultiClaim: Inconsistent lengths.')
            })

            it('fails to claim a loan with mismatched sizes', async function () {
                await setTime(0, contract)
                const multiclaimContract = await multiclaimContractBlueprint.deploy()
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 12000], [COLL_CCY_TOKEN, 8000]])

                const bits = approvalBits(['addLiquidity', 'claim'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(multiclaimContract.address, bits)
    
                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
    
                const loanAmount2 = 418
                const repaymentAmount2 = 596
    
                const shares2 = Math.floor(repaymentAmount / (liquidity - loanAmount - loanAmount2) * shares)
    
                // Note that although claiming the second loan is done after claimining the first loan, the liqudiity isn't
                // already updated with repaymentAmount. That's because the contract first computes all the repayments and
                // then deposits the new liquidity at the end
                const shares3 = Math.floor(repaymentAmount2 / (liquidity - loanAmount - loanAmount2) * (shares))
    
                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                // The contract doesn't allow atomic borrow + repay
                await setTime(2)
    
                await contract.connect(bob).repay(
                    1,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).repay(
                    2,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                await expect(
                    multiclaimContract.connect(alice).claimMultiple(
                        contract.address,
                        [],
                        [], // Reinvest
                        150
                    )
                ).to.be.revertedWith('MultiClaim: Empty loan index array.')
            })

            it('fails to claim a loan with an empty array', async function () {
                await setTime(0, contract)
                const multiclaimContract = await multiclaimContractBlueprint.deploy()
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 12000], [COLL_CCY_TOKEN, 8000]])

                const bits = approvalBits(['addLiquidity', 'claim'])
                console.log('Bits:', bits)
                await contract.connect(alice).setApprovals(multiclaimContract.address, bits)
    
                const liquidity = 8000
                const collateralPledge = 500
                const shares = 1000 * liquidity / MIN_LIQUIDITY
                // Precomputed
                const loanAmount = 428
                const repaymentAmount = 582
    
                const loanAmount2 = 418
                const repaymentAmount2 = 596
    
                const shares2 = Math.floor(repaymentAmount / (liquidity - loanAmount - loanAmount2) * shares)
    
                // Note that although claiming the second loan is done after claimining the first loan, the liqudiity isn't
                // already updated with repaymentAmount. That's because the contract first computes all the repayments and
                // then deposits the new liquidity at the end
                const shares3 = Math.floor(repaymentAmount2 / (liquidity - loanAmount - loanAmount2) * (shares))
    
                await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity, shares, REWARD_COEFFICIENT, 1
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
                
                // The contract doesn't allow atomic addLiquidity+borrow
                await setTime(1)
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).borrow(bob.address, // onBehalfOf
                        String(collateralPledge), 200, // minLoanLimit
                        10000, // maxRepayLimit
                        150, // deadline
                        0 // referralCode
                    )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                // The contract doesn't allow atomic borrow + repay
                await setTime(2)
    
                await contract.connect(bob).repay(
                    1,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )
    
                await contract.connect(bob).repay(
                    2,
                    bob.address
                )
    
                await checkQuery('getPoolInfo', [],
                    [
                        LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                        liquidity - loanAmount - loanAmount2, shares, REWARD_COEFFICIENT, 3
                    ]
                )
                await checkQuery('getLpInfo', [alice.address],
                    [
                        1, MIN_LPING_PERIOD, 0, [shares], []
                    ]
                )

                await expect(
                    multiclaimContract.connect(alice).claimMultiple(
                        contract.address,
                        [[1, 2], []],
                        [1, 1], // Reinvest
                        150
                    )
                ).to.be.revertedWith('MultiClaim: Empty loan index sub-array.')
            })
        })

        describe('emergency withdrawal', function() {
            beforeEach(async function () {
                emergencyWithdrawalContract = await emergencyWithdrawalContractBlueprint.deploy()
            })

            it('correctly approves and unapproves', async function () {
                const [alice, bob] = await newUsers([], [])

                await checkQuery('isApproved', [alice.address, contract.address, bob.address], [false], emergencyWithdrawalContract)

                await emergencyWithdrawalContract.connect(alice).approve(contract.address, bob.address)
                await checkQuery('isApproved', [alice.address, contract.address, bob.address], [true], emergencyWithdrawalContract)
                
                await emergencyWithdrawalContract.connect(alice).unapprove(contract.address, bob.address)
                await checkQuery('isApproved', [alice.address, contract.address, bob.address], [false], emergencyWithdrawalContract)
            })

            it('triggers a withdrawal', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 100000] ], [])

                await contract.connect(alice).addLiquidity(alice.address, '80000', 150, 0)

                await checkQuery('balanceOf', [alice.address], [String(20000)], loanCcyTokenContract)

                const bits = approvalBits(['removeLiquidity'])

                await contract.connect(alice).setApprovals(emergencyWithdrawalContract.address, bits)
                await emergencyWithdrawalContract.connect(alice).approve(contract.address, bob.address)

                await setTime(1 + MIN_LPING_PERIOD)

                await emergencyWithdrawalContract.connect(bob).collectEmergency(
                    contract.address,
                    alice.address
                )

                await checkQuery('balanceOf', [alice.address], [String(100000 - MIN_LIQUIDITY)], loanCcyTokenContract)
            })

            it('triggers a withdrawal even with a partial previous withdrawal', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 100000] ], [])

                await contract.connect(alice).addLiquidity(alice.address, '80000', 150, 0)

                const shares = 1000 * 80000 / MIN_LIQUIDITY

                await checkQuery('balanceOf', [alice.address], [String(20000)], loanCcyTokenContract)

                const bits = approvalBits(['removeLiquidity'])

                await contract.connect(alice).setApprovals(emergencyWithdrawalContract.address, bits)
                await emergencyWithdrawalContract.connect(alice).approve(contract.address, bob.address)

                await setTime(1 + MIN_LPING_PERIOD)

                await contract.connect(alice).removeLiquidity(alice.address, shares / 2)
                await checkQuery('balanceOf', [alice.address], [String(100000 - 80000 + ((80000 - MIN_LIQUIDITY) / 2))], loanCcyTokenContract)

                await emergencyWithdrawalContract.connect(bob).collectEmergency(
                    contract.address,
                    alice.address
                )

                await checkQuery('balanceOf', [alice.address], [String(100000 - MIN_LIQUIDITY)], loanCcyTokenContract)
            })

            it('fails to trigger a withdrawal without the emergency contract being authorized', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 100000] ], [])

                await contract.connect(alice).addLiquidity(alice.address, '80000', 150, 0)

                await checkQuery('balanceOf', [alice.address], [String(20000)], loanCcyTokenContract)

                const bits = approvalBits(['removeLiquidity'])

                // await contract.connect(alice).setApprovals(emergencyWithdrawalContract.address, bits)
                await emergencyWithdrawalContract.connect(alice).approve(contract.address, bob.address)

                await setTime(1 + MIN_LPING_PERIOD)

                await expect(
                    emergencyWithdrawalContract.connect(bob).collectEmergency(
                        contract.address,
                        alice.address
                    )
                ).to.be.eventually.rejectedWith('Sender not approved.');
            })

            it('fails to trigger a withdrawal without the escrow being approved', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 100000] ], [])

                await contract.connect(alice).addLiquidity(alice.address, '80000', 150, 0)

                await checkQuery('balanceOf', [alice.address], [String(20000)], loanCcyTokenContract)

                const bits = approvalBits(['removeLiquidity'])

                await contract.connect(alice).setApprovals(emergencyWithdrawalContract.address, bits)
                // await emergencyWithdrawalContract.connect(alice).approve(contract.address, bob.address)

                await setTime(1 + MIN_LPING_PERIOD)

                await expect(
                    emergencyWithdrawalContract.connect(bob).collectEmergency(
                        contract.address,
                        alice.address
                    )
                ).to.be.eventually.rejectedWith('Not approved');
            })

            it('fails to trigger a withdrawal for someone that is not a LP', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 100000] ], [])

                //await contract.connect(alice).addLiquidity(alice.address, '80000', 150, 0)

                const bits = approvalBits(['removeLiquidity'])

                await contract.connect(alice).setApprovals(emergencyWithdrawalContract.address, bits)
                await emergencyWithdrawalContract.connect(alice).approve(contract.address, bob.address)

                await setTime(1 + MIN_LPING_PERIOD)

                await expect(
                    emergencyWithdrawalContract.connect(bob).collectEmergency(
                        contract.address,
                        alice.address
                    )
                ).to.be.eventually.rejectedWith('No shares');
            })

            it('fails to trigger a withdrawal on a non-pool', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 100000] ], [])

                await contract.connect(alice).addLiquidity(alice.address, '80000', 150, 0)

                await checkQuery('balanceOf', [alice.address], [String(20000)], loanCcyTokenContract)

                const bits = approvalBits(['removeLiquidity'])

                await contract.connect(alice).setApprovals(emergencyWithdrawalContract.address, bits)
                // Using collCcyTokenContract as a non-pool
                await emergencyWithdrawalContract.connect(alice).approve(collCcyTokenContract.address, bob.address)

                await setTime(1 + MIN_LPING_PERIOD)

                await expect(
                    emergencyWithdrawalContract.connect(bob).collectEmergency(
                        collCcyTokenContract.address,
                        alice.address
                    )
                ).to.be.eventually.rejectedWith('function selector was not recognized');
            })

            it('fails to trigger a withdrawal for someone that already fully withdrew', async function () {
                const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 100000] ], [])

                await contract.connect(alice).addLiquidity(alice.address, '80000', 150, 0)

                const shares = 1000 * 80000 / MIN_LIQUIDITY

                await checkQuery('balanceOf', [alice.address], [String(20000)], loanCcyTokenContract)

                const bits = approvalBits(['removeLiquidity'])

                await contract.connect(alice).setApprovals(emergencyWithdrawalContract.address, bits)
                await emergencyWithdrawalContract.connect(alice).approve(contract.address, bob.address)

                await setTime(1 + MIN_LPING_PERIOD)

                await contract.connect(alice).removeLiquidity(alice.address, shares)

                await expect(
                    emergencyWithdrawalContract.connect(bob).collectEmergency(
                        contract.address,
                        alice.address
                    )
                ).to.be.eventually.rejectedWith('No shares');
            })
        })

        describe('ERC165', function () {
            it('checks that Controller supports IERC165', async function () {
                await expect(
                    controllerContract.supportsInterface('0x01ffc9a7')
                ).to.be.eventually.equal(true)
            })
    
            it('checks that Controller supports IController', async function () {
                await expect(
                    controllerContract.supportsInterface('0xef5f8ff3')
                ).to.be.eventually.equal(true)
            })
        })
    })

    describe('loanTerms', function () {
        const setups = [
            {
                maxLoanPerColl: MAX_LOAN_PER_COLL,
                r1: R1,
                r2: R2,
                l1 : LIQUIDITY_BND_1,
                l2: LIQUIDITY_BND_2,
                minLiquidity: MIN_LIQUIDITY,
                decimals : DECIMALS,
                creatorFee : CREATOR_FEE,
                tests : [
                    { liquidity : 8000, collateral : 500, loan : 428, repayment : 582, creatorFee : 0 },
                    { liquidity : 10000, collateral : 1000, loan : 833, repayment : 1016, creatorFee : 0 },
                    { liquidity : 20000, collateral : 100, loan : 99, repayment : 100, creatorFee : 0 }
                ]
            },
            {
                maxLoanPerColl: 1,
                r1: MONE.mul(5).div(10),
                r2: MONE.mul(1).div(100),
                l1 : 2000,
                l2: 2001,
                minLiquidity: 1000,
                decimals : 0,
                creatorFee : 0,
                tests : [
                    { liquidity : 2000, collateral : 10, loan : 9, repayment : 18, creatorFee : 0 },
                    { liquidity : 8000, collateral : 500, loan : 466, repayment : 470, creatorFee : 0 },
                    { liquidity : 10000, collateral : 1000, loan : 900, repayment : 909, creatorFee : 0 },
                ]
            },
            {
                maxLoanPerColl: 2,
                r1: MONE.mul(5).div(10),
                r2: MONE.mul(1).div(100),
                l1 : 2000,
                l2: 2100,
                minLiquidity: 1000,
                decimals : 0,
                creatorFee : 0,
                tests : [
                    { liquidity : 2000, collateral : 10, loan : 19, repayment : 38, creatorFee : 0 },
                    { liquidity : 8000, collateral : 500, loan : 875, repayment : 883, creatorFee : 0 },
                    { liquidity : 10000, collateral : 1000, loan : 1636, repayment : 1652, creatorFee : 0 },
                    { liquidity : 20000, collateral : 100, loan : 197, repayment : 198, creatorFee : 0 },
                ]
            },
            {
                maxLoanPerColl: BigNumber.from('100000').mul(471).div(100), // 4.71
                r1: MONE.mul(123).div(1000), // 12.3%
                r2: MONE.mul(75).div(1000), // 7.5%
                l1 : 1513,
                l2: 15464,
                minLiquidity: 1981,
                decimals : 5,
                creatorFee : 0,
                tests : [
                    { liquidity : 2701, collateral : 19, loan : 79, repayment : 100, creatorFee : 0 },
                    { liquidity : 8473, collateral : 521, loan : 1780, repayment : 1973, creatorFee : 0 },
                    { liquidity : 13455, collateral : 1444, loan : 4270, repayment : 4680, creatorFee : 0 },
                    { liquidity : 24320, collateral : 123, loan : 564, repayment : 606, creatorFee : 0 }
                ]
            },
            {
                maxLoanPerColl: BigNumber.from('100000').mul(471).div(100), // 4.71
                r1: MONE.mul(123).div(1000), // 12.3%
                r2: MONE.mul(75).div(1000), // 7.5%
                l1 : 1513,
                l2: 15464,
                minLiquidity: 1981,
                decimals : 5,
                creatorFee : MONE.mul(23).div(10000), // 0.23%
                tests : [
                    { liquidity : 2701, collateral : 19, loan : 79, repayment : 100, creatorFee : 0 },
                    { liquidity : 8473, collateral : 521, loan : 1778, repayment : 1971, creatorFee : 1 },
                    { liquidity : 13455, collateral : 1444, loan : 4264, repayment : 4673, creatorFee : 3 },
                    { liquidity : 24320, collateral : 123, loan : 564, repayment : 606, creatorFee : 0 },
                ]
            }
        ]
        for (const setup of setups) {
            it(`tests loanTerms with ${JSON.stringify(setup)}`, async function () {
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
    
                contract = await contractBlueprint.deploy(
                    [LOAN_CCY_TOKEN, COLL_CCY_TOKEN],
                    String(setup.decimals),
                    LOAN_TENOR,
                    String(setup.maxLoanPerColl),
                    [String(setup.r1), String(setup.r2)],
                    [String(setup.l1), String(setup.l2)],
                    '1',
                    String(setup.creatorFee),
                    String(setup.minLiquidity),
                    controllerContract.address, 
                    REWARD_COEFFICIENT
                )

                const [alice] = await newUsers([[LOAN_CCY_TOKEN, setup.tests[setup.tests.length - 1].liquidity]])

                let currentLiquidity = BigNumber.from(0)
                for (const test of setup.tests) {
                    const liquidity = BigNumber.from(test.liquidity)
                    if (currentLiquidity.lt(liquidity)) {
                        await contract.connect(alice).addLiquidity(alice.address, String(liquidity.sub(currentLiquidity)) ,150,0)
                    }

                    currentLiquidity = liquidity

                    await checkQuery('loanTerms', [test.collateral],
                        [test.loan, test.repayment, test.collateral - test.creatorFee , test.creatorFee, test.liquidity]
                    )
                }
            })
        }
    })

    describe('creatorFee', function () {
        it('checks that the Controller receives the creator fee', async function () {
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

            expect(controllerContract.address).to.be.a('string')
            expect(await controllerContract.voteToken()).to.be.deep.equal(VOTE_TOKEN)
            expect(await controllerContract.pauseThreshold()).to.be.deep.equal(String(PAUSE_THRESHOLD))
            expect(await controllerContract.unpauseThreshold()).to.be.deep.equal(String(UNPAUSE_THRESHOLD))
            expect(await controllerContract.whitelistThreshold()).to.be.deep.equal(String(WHITELIST_THRESHOLD))
            expect(await controllerContract.dewhitelistThreshold()).to.be.deep.equal(String(DEWHITELIST_THRESHOLD))
            expect(await controllerContract.snapshotTokenEvery()).to.be.deep.equal(String(SNAPSHOT_TOKEN_EVERY))
            expect(await controllerContract.lockPeriod()).to.be.deep.equal(String(CONTROLLER_LOCK_PERIOD))
            expect(await controllerContract.vetoHolder()).to.be.deep.equal(String(deployer.address))

            contract = await contractBlueprint.deploy(
                [LOAN_CCY_TOKEN, COLL_CCY_TOKEN],
                DECIMALS,
                LOAN_TENOR,
                MAX_LOAN_PER_COLL,
                [R1, R2],
                [LIQUIDITY_BND_1, LIQUIDITY_BND_2],
                MIN_LOAN,
                MONE.mul(27).div(10000).toString(),
                MIN_LIQUIDITY,
                controllerContract.address,
                REWARD_COEFFICIENT
            )

            await setTime(0)
            await setTime(0, controllerContract)

            const [alice, bob, voter] = await newUsers(
                [ [LOAN_CCY_TOKEN, 8000] ],
                [ [LOAN_CCY_TOKEN, 10000], [COLL_CCY_TOKEN, 8000] ],
                [ [VOTE_TOKEN, 1000] ])

            const liquidity = 8000
            const collateralPledge = 1245
            // Precomputed
            const creatorFee = Math.floor(collateralPledge * 0.0027)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)
            
            // The contract doesn't allow atomic addLiquidity + borrow
            await setTime(1)
            await setTime(1, controllerContract)

            await contract.connect(bob).borrow(bob.address, // onBehalfOf
                    String(collateralPledge), 200, // minLoanLimit
                    10000, // maxRepayLimit
                    150, // deadline
                    0 // referralCode
                )

            await checkQuery('numTokenSnapshots', [COLL_CCY_TOKEN], [0], controllerContract)
            await checkQuery('currentRevenue', [COLL_CCY_TOKEN], [creatorFee], controllerContract)

            await controllerContract.connect(voter).depositVoteToken(String(100))
            await setTime(101, controllerContract)
            await controllerContract.connect(voter).forceTokenSnapshotCheck(COLL_CCY_TOKEN)

            await checkQuery('numTokenSnapshots', [COLL_CCY_TOKEN], [1], controllerContract)
            await checkQuery('getTokenSnapshot', [COLL_CCY_TOKEN, 0], [100, creatorFee, 0, 101, 0], controllerContract)

            const beforeClaim = await collCcyTokenContract.balanceOf(voter.address)
            await controllerContract.connect(voter).claimToken(COLL_CCY_TOKEN, 0, 0)
            const afterClaim = await collCcyTokenContract.balanceOf(voter.address)
            expect(afterClaim.sub(beforeClaim)).to.be.deep.equal(BigNumber.from(creatorFee))
        })
    })

    describe('Controller failure tolerance', function () {
        it('checks that BasePool works even with a misconfigured Controller', async function () {
            const mockFakeControllerBlueprint = await hre.ethers.getContractFactory('MockFakeController')
            const mockFakeControllerContract = await mockFakeControllerBlueprint.deploy()
            contract = await contractBlueprint.deploy(
                [LOAN_CCY_TOKEN, COLL_CCY_TOKEN],
                DECIMALS,
                LOAN_TENOR,
                MAX_LOAN_PER_COLL,
                [R1, R2],
                [LIQUIDITY_BND_1, LIQUIDITY_BND_2],
                MIN_LOAN,
                '0',
                MIN_LIQUIDITY,
                mockFakeControllerContract.address, // This contract will revert on all actual calls
                REWARD_COEFFICIENT
            )

            await setTime(0)

            console.log('Completed deployment.')

            // Do a classic addLiquidity + borrow + repay + claim

            const [alice, bob] = await newUsers([ [LOAN_CCY_TOKEN, 8000] ], [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

            const liquidity = 8000
            const collateralPledge = 500
            const shares = 1000 * liquidity / MIN_LIQUIDITY
            // Precomputed
            const loanAmount = 428
            const repaymentAmount = 582

            const shares2 = Math.floor((repaymentAmount - loanAmount) / (liquidity - loanAmount) * shares)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity) ,150,0)

            await checkQuery('getPoolInfo', [],
                [
                    LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                    liquidity, shares, REWARD_COEFFICIENT, 1
                ]
            )
            await checkQuery('getLpInfo', [alice.address],
                [
                    1, MIN_LPING_PERIOD, 0, [shares], []
                ]
            )
            
            // The contract doesn't allow atomic addLiquidity+borrow
            await setTime(1)

            await contract.connect(bob).borrow(bob.address, // onBehalfOf
                    String(collateralPledge), 200, // minLoanLimit
                    10000, // maxRepayLimit
                    150, // deadline
                    0 // referralCode
                )

            await checkQuery('getPoolInfo', [],
                [
                    LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                    liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                ]
            )
            await checkQuery('getLpInfo', [alice.address],
                [
                    1, MIN_LPING_PERIOD, 0, [shares], []
                ]
            )

            // The contract doesn't allow atomic borrow + repay
            await setTime(2)

            await contract.connect(bob).repay(
                1,
                bob.address
            )

            await checkQuery('getPoolInfo', [],
                [
                    LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                    liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                ]
            )
            await checkQuery('getLpInfo', [alice.address],
                [
                    1, MIN_LPING_PERIOD, 0, [shares], []
                ]
            )

            const tx1 = await contract.connect(alice).claim(
                    alice.address,
                    [1],
                    0, // Don't reinvest
                    150
                )

            // The liquidity and shares don't change because the user didn't reinvest
            await checkQuery('getPoolInfo', [],
                [
                    LOAN_CCY_TOKEN, COLL_CCY_TOKEN, MAX_LOAN_PER_COLL, MIN_LOAN, LOAN_TENOR,
                    liquidity - loanAmount, shares, REWARD_COEFFICIENT, 2
                ]
            )
            await checkQuery('getLpInfo', [alice.address],
                [
                    2, MIN_LPING_PERIOD, 0, [shares], []
                ]
            )

            await checkEvents(tx1, [{
                lp : alice.address,
                loanIdxs : [1],
                repayments : repaymentAmount,
                collateral : 0
            }])
            expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(8000 - liquidity + repaymentAmount))
        })

        it('fails to deploy a contract with an invalid address as Controller', async function () {
            await expect(contractBlueprint.deploy(
                [LOAN_CCY_TOKEN, COLL_CCY_TOKEN],
                DECIMALS,
                LOAN_TENOR,
                MAX_LOAN_PER_COLL,
                [R1, R2],
                [LIQUIDITY_BND_1, LIQUIDITY_BND_2],
                MIN_LOAN,
                '0',
                MIN_LIQUIDITY,
                LOAN_CCY_TOKEN, // Using an unrelated address instead of Controller 
                REWARD_COEFFICIENT
            )).to.be.rejectedWith('Invalid Controller.')
        })

        it('fails to deploy a contract with a zero address as Controller', async function () {
            await expect(contractBlueprint.deploy(
                [LOAN_CCY_TOKEN, COLL_CCY_TOKEN],
                DECIMALS,
                LOAN_TENOR,
                MAX_LOAN_PER_COLL,
                [R1, R2],
                [LIQUIDITY_BND_1, LIQUIDITY_BND_2],
                MIN_LOAN,
                '0',
                MIN_LIQUIDITY,
                ZERO_ADDRESS, 
                REWARD_COEFFICIENT
            )).to.be.rejectedWith('Invalid Controller.')
        })
    })

    describe('reward requests', function () {
        beforeEach(async function () {
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

            contract = await contractBlueprint.deploy(
                [LOAN_CCY_TOKEN, COLL_CCY_TOKEN],
                DECIMALS,
                LOAN_TENOR,
                MAX_LOAN_PER_COLL,
                [R1, R2],
                [LIQUIDITY_BND_1, LIQUIDITY_BND_2],
                MIN_LOAN,
                '0',
                MIN_LIQUIDITY,
                controllerContract.address, 
                MONE.mul(567).div(100).toString()
            )

            await setTime(0)
            await setTime(0, controllerContract)

            const [voter] = await newUsers([[VOTE_TOKEN, 200000000]])

            await controllerContract.connect(voter).depositRewardSupply(
                String(100000000)
            )

            await checkQuery('rewardSupply', [], [String(100000000)], controllerContract)

            await controllerContract.connect(voter).depositVoteToken(
                String(10000)
            )

            await controllerContract.connect(voter).createProposal(
                contract.address,
                Actions.Whitelist,
                150
            )

            await controllerContract.connect(deployer).setVetoHolderApproval(
                0,
                true
            )

            await controllerContract.connect(voter).vote(
                0
            )

            await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)
        })

        it('checks that rewards are distributed correctly with addLiquidity', async function () {
            const [alice] = await newUsers([[LOAN_CCY_TOKEN, 100000]])

            const coefficient = 5.67

            const time1 = 17
            const liquidity1 = 321
            const reward1 = 0

            const time2 = 73
            const liquidity2 = 1343
            const reward2 = Math.floor((time2 - time1) * liquidity1 * coefficient)

            const time3 = 985
            const liquidity3 = 2245
            const reward3 = Math.floor((time3 - time2) * liquidity2 * coefficient)

            await setTime(time1)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity1) ,10000,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [time1])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity1])
            //await controllerContract.waitForHeight(await contract.height())
            //await controllerContract.waitForHeight((await contract.height()) + 1)
            await checkQuery('rewardBalance', [alice.address], [reward1], controllerContract)

            await setTime(time2)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity2 - liquidity1) ,10000,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [time2])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity2])

            await checkQuery('rewardBalance', [alice.address], [reward1 + reward2], controllerContract)

            await setTime(time3)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity3 - liquidity2) ,10000,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [time3])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity3])
            
            await checkQuery('rewardBalance', [alice.address], [reward1 + reward2 + reward3], controllerContract)
        })

        it('checks that rewards are distributed correctly with removeLiquidity', async function () {
            const [alice] = await newUsers([[LOAN_CCY_TOKEN, 100000]])

            await checkQuery('poolWhitelisted', [contract.address], [true], controllerContract)

            const coefficient = 5.67

            const time1 = 17
            const liquidity1 = 13215
            const shares1 = 1000 * liquidity1 / MIN_LIQUIDITY
            const reward1 = 0

            const time2 = 345
            const sharesRemoved2 = Math.floor(shares1 * 0.17)
            const liquidityRemoved2 = Math.floor(sharesRemoved2 / shares1 * (liquidity1 - MIN_LIQUIDITY))
            const shares2 = shares1 - sharesRemoved2
            const liquidity2 = liquidity1 - liquidityRemoved2
            const reward2 = Math.floor((time2 - time1) * liquidity1 * coefficient)

            const time3 = 985
            const sharesRemoved3 = shares2
            const liquidity3 = MIN_LIQUIDITY
            const reward3 = Math.floor((time3 - time2) * liquidity2 * coefficient)

            await setTime(time1)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity1) ,10000,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [time1])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity1])
            
            await checkQuery('rewardBalance', [alice.address], [reward1], controllerContract)

            await setTime(time2)

            await contract.connect(alice).removeLiquidity(
                    alice.address, // onBehalfOf
                    String(sharesRemoved2)
                )

            await checkQuery('lastRewardTimestamp', [alice.address], [time2])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity2])

            
            await checkQuery('rewardBalance', [alice.address], [reward1 + reward2], controllerContract)

            await setTime(time3)

            await contract.connect(alice).removeLiquidity(
                    alice.address, // onBehalfOf
                    sharesRemoved3
                )

            await checkQuery('lastRewardTimestamp', [alice.address], [time3])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity3])
            
            await checkQuery('rewardBalance', [alice.address], [reward1 + reward2 + reward3], controllerContract)
        })

        it('checks that rewards are distributed correctly with claim (without re-invest)', async function () {
            const [alice, bob, charlie] = await newUsers(
                [[LOAN_CCY_TOKEN, 6000]],
                [[LOAN_CCY_TOKEN, 2000]],
                [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

            const coefficient = 5.67

            const addLiquidityTime = 23
            const loanTime = 42
            const liquidityAlice = 6000
            const liquidityBob = 2000
            const liquidity = liquidityAlice + liquidityBob
            const collateralPledge = 500
            const sharesAlice = 1000 * liquidityAlice / MIN_LIQUIDITY
            const sharesBob = Math.floor(liquidityBob / liquidityAlice * sharesAlice)

            // Precomputed
            const loanAmount = 428
            const loanAlice = Math.floor(loanAmount * liquidityAlice / liquidity)
            const loanBob = Math.floor(loanAmount * liquidityBob / liquidity)
            const repaymentAmount = 582
            const repaymentAlice = Math.floor(repaymentAmount * liquidityAlice / liquidity)
            const repaymentBob = Math.floor(repaymentAmount * liquidityBob / liquidity)

            const claimTimeAlice = 353
            const claimTimeBob = 424

            const rewardAlice = Math.floor((claimTimeAlice - addLiquidityTime) * liquidityAlice * coefficient)
            const rewardBob = Math.floor((claimTimeBob - addLiquidityTime) * liquidityBob * coefficient)

            const liquidityAlice2 = liquidityAlice - loanAlice
            const liquidityBob2 = liquidityBob - loanBob

            //const shares2 = Math.floor((repaymentAmount - loanAmount) / (liquidity - loanAmount) * shares)

            await setTime(addLiquidityTime)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice) ,150,0)

            await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob) ,150,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidityAlice])
            await checkQuery('lastRewardTimestamp', [bob.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [bob.address], [liquidityBob])
            
            await checkQuery('rewardBalance', [alice.address], [0], controllerContract)
            await checkQuery('rewardBalance', [bob.address], [0], controllerContract)

            // The contract doesn't allow atomic addLiquidity+borrow
            await setTime(loanTime)

            await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                    String(collateralPledge), 200, // minLoanLimit
                    10000, // maxRepayLimit
                    10000, // deadline
                    0 // referralCode
                )

            // The contract doesn't allow atomic borrow + repay
            await setTime(loanTime + 1)

            await contract.connect(charlie).repay(
                1,
                charlie.address
            )


            // Nothing changed
            await checkQuery('lastRewardTimestamp', [alice.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidityAlice])
            await checkQuery('lastRewardTimestamp', [bob.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [bob.address], [liquidityBob])
            await checkQuery('rewardBalance', [alice.address], [0], controllerContract)
            await checkQuery('rewardBalance', [bob.address], [0], controllerContract)

            await setTime(claimTimeAlice)

            await contract.connect(alice).claim(
                    alice.address,
                    [1],
                    0, // Don't reinvest
                    10000
                )

            await checkQuery('lastRewardTimestamp', [alice.address], [claimTimeAlice])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidityAlice2])
            await checkQuery('lastRewardTimestamp', [bob.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [bob.address], [liquidityBob])
            await checkQuery('rewardBalance', [alice.address], [rewardAlice], controllerContract)
            await checkQuery('rewardBalance', [bob.address], [0], controllerContract)

            expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(repaymentAlice))

            await setTime(claimTimeBob)

            await contract.connect(bob).claim(
                    bob.address,
                    [1],
                    0, // Don't reinvest
                    10000
                )

            await checkQuery('lastRewardTimestamp', [alice.address], [claimTimeAlice])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidityAlice2])
            await checkQuery('lastRewardTimestamp', [bob.address], [claimTimeBob])
            await checkQuery('lastTrackedLiquidity', [bob.address], [liquidityBob2])
            await checkQuery('rewardBalance', [alice.address], [rewardAlice], controllerContract)
            await checkQuery('rewardBalance', [bob.address], [rewardBob], controllerContract)

            expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(repaymentAlice))
            expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(repaymentBob))
        })

        it('checks that rewards are distributed correctly with claim (with re-invest)', async function () {
            const [alice, bob, charlie] = await newUsers(
                [[LOAN_CCY_TOKEN, 6000]],
                [[LOAN_CCY_TOKEN, 2000]],
                [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

            const coefficient = 5.67

            const addLiquidityTime = 23
            const loanTime = 42
            const liquidityAlice = 6000
            const liquidityBob = 2000
            const liquidity = liquidityAlice + liquidityBob
            const collateralPledge = 500

            // Precomputed
            const loanAmount = 428
            const loanAlice = Math.floor(loanAmount * liquidityAlice / liquidity)
            const loanBob = Math.floor(loanAmount * liquidityBob / liquidity)
            const repaymentAmount = 582
            const repaymentAlice = Math.floor(repaymentAmount * liquidityAlice / liquidity)
            const repaymentBob = Math.floor(repaymentAmount * liquidityBob / liquidity)

            const claimTimeAlice = 353
            const claimTimeBob = 424

            const rewardAlice = Math.floor((claimTimeAlice - addLiquidityTime) * liquidityAlice * coefficient)
            const rewardBob = Math.floor((claimTimeBob - addLiquidityTime) * liquidityBob * coefficient)

            const liquidityAlice2 = liquidityAlice - loanAlice + repaymentAlice
            const liquidityBob2 = liquidityBob - loanBob + repaymentBob

            //const shares2 = Math.floor((repaymentAmount - loanAmount) / (liquidity - loanAmount) * shares)

            await setTime(addLiquidityTime)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidityAlice) ,150,0)

            await contract.connect(bob).addLiquidity(bob.address, String(liquidityBob) ,150,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidityAlice])
            await checkQuery('lastRewardTimestamp', [bob.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [bob.address], [liquidityBob])
            await checkQuery('rewardBalance', [alice.address], [0], controllerContract)
            await checkQuery('rewardBalance', [bob.address], [0], controllerContract)

            // The contract doesn't allow atomic addLiquidity+borrow
            await setTime(loanTime)

            await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                    String(collateralPledge), 200, // minLoanLimit
                    10000, // maxRepayLimit
                    10000, // deadline
                    0 // referralCode
                )

            // The contract doesn't allow atomic borrow + repay
            await setTime(loanTime + 1)

            await contract.connect(charlie).repay(
                1,
                charlie.address
            )


            // Nothing changed
            await checkQuery('lastRewardTimestamp', [alice.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidityAlice])
            await checkQuery('lastRewardTimestamp', [bob.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [bob.address], [liquidityBob])
            
            await checkQuery('rewardBalance', [alice.address], [0], controllerContract)
            await checkQuery('rewardBalance', [bob.address], [0], controllerContract)

            await setTime(claimTimeAlice)

            await contract.connect(alice).claim(
                    alice.address,
                    [1],
                    1, // Reinvest
                    10000
                )

            await checkQuery('lastRewardTimestamp', [alice.address], [claimTimeAlice])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidityAlice2])
            await checkQuery('lastRewardTimestamp', [bob.address], [addLiquidityTime])
            await checkQuery('lastTrackedLiquidity', [bob.address], [liquidityBob])
            await checkQuery('rewardBalance', [alice.address], [rewardAlice], controllerContract)
            await checkQuery('rewardBalance', [bob.address], [0], controllerContract)

            expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(0))

            await setTime(claimTimeBob)

            await contract.connect(bob).claim(
                    bob.address,
                    [1],
                    1, // Reinvest
                    10000
                )

            await checkQuery('lastRewardTimestamp', [alice.address], [claimTimeAlice])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidityAlice2])
            await checkQuery('lastRewardTimestamp', [bob.address], [claimTimeBob])
            await checkQuery('lastTrackedLiquidity', [bob.address], [liquidityBob2])
            await checkQuery('rewardBalance', [alice.address], [rewardAlice], controllerContract)
            await checkQuery('rewardBalance', [bob.address], [rewardBob], controllerContract)

            expect(await loanCcyTokenContract.balanceOf(alice.address)).to.be.deep.equal(String(0))
            expect(await loanCcyTokenContract.balanceOf(bob.address)).to.be.deep.equal(String(0))
        })

        it('checks that rewards are distributed correctly with forceRewardUpdate', async function () {
            const [alice] = await newUsers([[LOAN_CCY_TOKEN, 100000]])

            const coefficient = 5.67

            const time1 = 17
            const liquidity1 = 321
            const reward1 = 0

            const time2 = 73
            const liquidity2 = liquidity1
            const reward2 = Math.floor((time2 - time1) * liquidity1 * coefficient)

            const time3 = 985
            const liquidity3 = 2245
            const reward3 = Math.floor((time3 - time2) * liquidity2 * coefficient)

            await setTime(time1)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity1) ,10000,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [time1])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity1])
            await checkQuery('rewardBalance', [alice.address], [reward1], controllerContract)

            await setTime(time2)

            await contract.connect(alice).forceRewardUpdate(
                    alice.address, // onBehalfOf
                )

            await checkQuery('lastRewardTimestamp', [alice.address], [time2])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity2])

            await checkQuery('rewardBalance', [alice.address], [reward1 + reward2], controllerContract)

            await setTime(time3)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity3 - liquidity2) ,10000,0)


            await checkQuery('lastRewardTimestamp', [alice.address], [time3])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity3])
            await checkQuery('rewardBalance', [alice.address], [reward1 + reward2 + reward3], controllerContract)
        })

        it('forces a reward update for an authorized address', async function () {
            const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 100000]], [])

            const bits = approvalBits(['forceRewardUpdate'])
            console.log('Bits:', bits)
            await contract.connect(alice).setApprovals(bob.address, bits)

            console.log('Approved')

            const coefficient = 5.67

            const time1 = 17
            const liquidity1 = 321
            const reward1 = 0

            const time2 = 73
            const liquidity2 = liquidity1
            const reward2 = Math.floor((time2 - time1) * liquidity1 * coefficient)

            const time3 = 985
            const liquidity3 = 2245
            const reward3 = Math.floor((time3 - time2) * liquidity2 * coefficient)

            await setTime(time1)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity1) ,10000,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [time1])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity1])
            await checkQuery('rewardBalance', [alice.address], [reward1], controllerContract)

            await setTime(time2)

            await contract.connect(bob).forceRewardUpdate(
                    alice.address, // onBehalfOf
                )

            console.log('Forced update')

            await checkQuery('lastRewardTimestamp', [alice.address], [time2])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity2])

            await checkQuery('rewardBalance', [alice.address], [reward1 + reward2], controllerContract)

            await setTime(time3)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity3 - liquidity2) ,10000,0)

            
            console.log('Added liquidity 2')

            await checkQuery('lastRewardTimestamp', [alice.address], [time3])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity3])
            await checkQuery('rewardBalance', [alice.address], [reward1 + reward2 + reward3], controllerContract)
        })

        it('fails to force a reward update for an unauthorized address', async function () {
            const [alice, bob] = await newUsers([[LOAN_CCY_TOKEN, 100000]], [])

            const bits = approvalBits(['repay', 'addLiquidity', 'removeLiquidity', 'claim'])
            console.log('Bits:', bits)
            await contract.connect(alice).setApprovals(bob.address, bits)

            const time1 = 17
            const liquidity1 = 321
            const reward1 = 0

            const time2 = 73

            await setTime(time1)

            await contract.connect(alice).addLiquidity(alice.address, String(liquidity1) ,10000,0)

            await checkQuery('lastRewardTimestamp', [alice.address], [time1])
            await checkQuery('lastTrackedLiquidity', [alice.address], [liquidity1])
            await checkQuery('rewardBalance', [alice.address], [reward1], controllerContract)

            await setTime(time2)

            await expect(
                contract.connect(bob).forceRewardUpdate(
                        alice.address, // onBehalfOf
                    )
            ).to.be.revertedWith('Sender not approved.')
        })

        it('checks that rewards are distributed correctly with a mix of operations', async function () {
            const [alice, bob, charlie] = await newUsers(
                [[LOAN_CCY_TOKEN, 16000]],
                [[LOAN_CCY_TOKEN, 12000]],
                [[LOAN_CCY_TOKEN, 8000], [COLL_CCY_TOKEN, 8000]])

            const coefficient = 5.67

            let liquidityAlice = 0
            let liquidityBob = 0
            const totalLiquidity = () => liquidityAlice + liquidityBob
            const collateralPledge = 500

            let trackedLiquidityAlice = liquidityAlice
            let trackedLiquidityBob = liquidityBob

            let sharesAlice = 0
            let sharesBob = 0
            const totalShares = () => sharesAlice + sharesBob

            let lastRewardTimestampAlice = 0
            let lastRewardTimestampBob = 0

            let totalRewardAlice = 0
            let totalRewardBob = 0

            // 1. Add Alice
            // 1. Add Bob
            // 2. Loan
            // 3. Remove Alice
            // 4. Add Bob
            // 5. Force Alice
            // 6. Claim Alice (without re-invest)
            // 7. Remove Bob
            // 8. Force Bob
            // 9. Claim Bob (with re-invest)
            // 10. Add Alice
            
            const checkTracked = async () => {
                await checkQuery('lastRewardTimestamp', [alice.address], [lastRewardTimestampAlice])
                await checkQuery('lastTrackedLiquidity', [alice.address], [trackedLiquidityAlice])
                await checkQuery('lastRewardTimestamp', [bob.address], [lastRewardTimestampBob])
                await checkQuery('lastTrackedLiquidity', [bob.address], [trackedLiquidityBob])
                await checkQuery('rewardBalance', [alice.address], [totalRewardAlice], controllerContract)
                await checkQuery('rewardBalance', [bob.address], [totalRewardBob], controllerContract)
            }

            await setTime(31)

            await contract.connect(alice).addLiquidity(alice.address, String(6000) ,10000,0)
            liquidityAlice += 6000
            trackedLiquidityAlice += 6000
            sharesAlice += 1000 * liquidityAlice / MIN_LIQUIDITY
            lastRewardTimestampAlice = 31

            await checkTracked()

            await contract.connect(bob).addLiquidity(bob.address, String(2000) ,10000,0)
            trackedLiquidityBob += 2000
            sharesBob += Math.floor(2000 / totalLiquidity() * totalShares())
            liquidityBob += 2000
            lastRewardTimestampBob = 31

            await checkTracked()

            // Precomputed
            const loanAmount = 428
            const loanAlice = Math.floor(loanAmount * liquidityAlice / totalLiquidity())
            const loanBob = Math.floor(loanAmount * liquidityBob / totalLiquidity())
            const repaymentAmount = 582
            
            const repaymentAlice = Math.floor(repaymentAmount * liquidityAlice / totalLiquidity())
            const repaymentBob = Math.floor(repaymentAmount * liquidityBob / totalLiquidity())

            await contract.connect(charlie).borrow(charlie.address, // onBehalfOf
                    String(collateralPledge), 200, // minLoanLimit
                    10000, // maxRepayLimit
                    10000, // deadline
                    0 // referralCode
                )
            liquidityAlice -= loanAlice
            liquidityBob -= loanBob
            await checkTracked()

            // The contract doesn't allow atomic borrow + repay
            await setTime(32)

            await contract.connect(charlie).repay(
                1,
                charlie.address
            )

            await checkTracked()

            // Alice removes 17% of her shares

            await setTime(171)
            const sharesRemovedAlice = Math.floor(sharesAlice * 0.17)
            const liquidityRemovedAlice = Math.floor(sharesRemovedAlice / totalShares() * (totalLiquidity() - MIN_LIQUIDITY))

            console.log('Current liquidity:', totalLiquidity())
            console.log('Current shares:', totalShares())
            console.log('Removing', sharesRemovedAlice, 'shares and', liquidityRemovedAlice, 'liquidity')

            await contract.connect(alice).removeLiquidity(
                    alice.address,
                    sharesRemovedAlice
                )

            totalRewardAlice += Math.floor((171 - lastRewardTimestampAlice) * coefficient * trackedLiquidityAlice)
            liquidityAlice -= liquidityRemovedAlice
            trackedLiquidityAlice -= liquidityRemovedAlice
            sharesAlice -= sharesRemovedAlice
            lastRewardTimestampAlice = 171

            await checkTracked()

            await setTime(233)

            // Bob adds 1571 liquidity
            
            await contract.connect(bob).addLiquidity(bob.address, String(1571) ,10000,0)

            totalRewardBob += Math.floor((233 - lastRewardTimestampBob) * coefficient * trackedLiquidityBob)
            sharesBob += Math.floor(1571 / totalLiquidity() * totalShares())
            liquidityBob += 1571
            trackedLiquidityBob += 1571
            lastRewardTimestampBob = 233

            await checkTracked()

            await setTime(313)

            await contract.connect(alice).forceRewardUpdate(
                    alice.address
                )
            totalRewardAlice += Math.floor((313 - lastRewardTimestampAlice) * coefficient * trackedLiquidityAlice)
            lastRewardTimestampAlice = 313

            await checkTracked()

            // Alice claims (without re-investing)

            await setTime(431)

            await contract.connect(alice).claim(
                    alice.address,
                    [1],
                    0, // Don't reinvest
                    10000
                )
            totalRewardAlice += Math.floor((431 - lastRewardTimestampAlice) * coefficient * trackedLiquidityAlice)
            trackedLiquidityAlice -= loanAlice
            lastRewardTimestampAlice = 431

            await checkTracked()

            // Bob removes 9.3% of his shares

            await setTime(563)

            const sharesRemovedBob = Math.floor(sharesBob * 0.093)
            const liquidityRemovedBob = Math.floor(sharesRemovedBob / totalShares() * (totalLiquidity() - MIN_LIQUIDITY))

            await contract.connect(bob).removeLiquidity(
                    bob.address,
                    sharesRemovedBob
                )
            totalRewardBob += Math.floor((563 - lastRewardTimestampBob) * coefficient * trackedLiquidityBob)
            liquidityBob -= liquidityRemovedBob
            trackedLiquidityBob -= liquidityRemovedBob
            sharesBob -= sharesRemovedBob
            lastRewardTimestampBob = 563

            await checkTracked()

            // Bob forces an update

            await setTime(569)

            await contract.connect(bob).forceRewardUpdate(
                    bob.address
                )
            totalRewardBob += Math.floor((569 - lastRewardTimestampBob) * coefficient * trackedLiquidityBob)
            lastRewardTimestampBob = 569

            await checkTracked()

            // Bob claims and re-invests

            await setTime(602)

            await contract.connect(bob).claim(
                    bob.address,
                    [1],
                    1, // Reinvest
                    10000
                )
            totalRewardBob += Math.floor((602 - lastRewardTimestampBob) * coefficient * trackedLiquidityBob)
            sharesBob += Math.floor(repaymentBob / totalLiquidity() * totalShares())
            liquidityBob += repaymentBob
            trackedLiquidityBob += repaymentBob - loanBob
            lastRewardTimestampBob = 602

            await checkTracked()

            // Alice adds 451 liquidity

            await setTime(751)

            await contract.connect(alice).addLiquidity(alice.address, String(451) ,10000,0)
            totalRewardAlice += Math.floor((751 - lastRewardTimestampAlice) * coefficient * trackedLiquidityAlice)
            sharesAlice += Math.floor(451 / totalLiquidity() * totalShares())
            liquidityAlice += 451
            trackedLiquidityAlice += 451
            lastRewardTimestampAlice = 751

            await checkTracked()
        })
    })
});
