// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {BasePool} from "../../contracts/BasePool.sol";
import {IController} from "../../contracts/interfaces/IController.sol";
import {MockRewardController} from "./mocks/MockRewardController.sol";
import {RewardInvariantHandler} from "./RewardInvariant.handler.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TestToken is ERC20 {
    constructor() ERC20("Test", "TST") {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title RewardInvariantTest
 * @notice Foundry stateful invariant test for audit finding S1 — the unproven
 *         non-underflow invariant in BasePool reward bookkeeping.
 *
 * Pool parameters mirror test/pool.spec.ts (the inherited MYSO core suite) so
 * the fuzzed scenarios stay inside the realistic input space the project ships,
 * EXCEPT the reward coefficient, which is set NON-ZERO here (the core suite runs
 * it at 0; see finding T1). REWARD_BASE = 1e18.
 */
contract RewardInvariantTest is Test {
    BasePool pool;
    MockRewardController controller;
    TestToken loanCcy;
    TestToken collCcy;
    RewardInvariantHandler handler;

    // Mirror test/pool.spec.ts constants.
    uint256 constant LOAN_TENOR = 86400;
    uint256 constant MAX_LOAN_PER_COLL = 1;
    uint256 constant LIQUIDITY_BND_1 = 5000;
    uint256 constant LIQUIDITY_BND_2 = 10000;
    uint256 constant MIN_LOAN = 200;
    uint256 constant DECIMALS = 0;
    uint256 constant MIN_LIQUIDITY = 5000;
    uint256 constant CREATOR_FEE = 8;
    // Non-zero reward coefficient (BASE = 1e18). 1e15 = 0.001 reward units per
    // (liquidity * second). Chosen to keep amounts meaningful but not exhaust
    // a large supply in a single op.
    uint96 constant REWARD_COEFFICIENT = 1e15;
    // r1 = 0.2 * BASE, r2 = 0.02 * BASE (matches spec R1/R2).
    uint256 constant R1 = 2 * 1e17;
    uint256 constant R2 = 2 * 1e16;

    function setUp() public {
        // Start at a non-trivial, uint32-safe timestamp.
        vm.warp(1_000_000);

        loanCcy = new TestToken();
        collCcy = new TestToken();
        controller = new MockRewardController();
        // Fund the reward supply generously so distributions are real but the
        // saturating clamp in requestTokenDistribution is rarely hit.
        controller.setRewardSupply(type(uint128).max);

        IERC20[] memory tokens = new IERC20[](2);
        tokens[0] = IERC20(address(loanCcy));
        tokens[1] = IERC20(address(collCcy));
        uint256[] memory rs = new uint256[](2);
        rs[0] = R1;
        rs[1] = R2;
        uint256[] memory bnds = new uint256[](2);
        bnds[0] = LIQUIDITY_BND_1;
        bnds[1] = LIQUIDITY_BND_2;

        pool = new BasePool(
            tokens,
            DECIMALS,
            LOAN_TENOR,
            MAX_LOAN_PER_COLL,
            rs,
            bnds,
            MIN_LOAN,
            CREATOR_FEE,
            MIN_LIQUIDITY,
            IController(address(controller)),
            REWARD_COEFFICIENT
        );

        // Set up actors: 3 LPs and 2 borrowers, all richly funded + approved.
        address[] memory lps = new address[](3);
        address[] memory borrowers = new address[](2);
        for (uint256 i = 0; i < 3; i++) {
            lps[i] = address(uint160(0x1000 + i));
            _fund(lps[i]);
        }
        for (uint256 i = 0; i < 2; i++) {
            borrowers[i] = address(uint160(0x2000 + i));
            _fund(borrowers[i]);
        }

        handler = new RewardInvariantHandler(
            pool, controller, IERC20(address(loanCcy)), IERC20(address(collCcy)), lps, borrowers
        );

        // Target the handler for invariant fuzzing.
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.addLiquidity.selector;
        selectors[1] = handler.removeLiquidity.selector;
        selectors[2] = handler.borrow.selector;
        selectors[3] = handler.repay.selector;
        selectors[4] = handler.claim.selector;
        selectors[5] = handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _fund(address who) internal {
        loanCcy.mintTo(who, type(uint128).max);
        collCcy.mintTo(who, type(uint128).max);
        vm.startPrank(who);
        loanCcy.approve(address(pool), type(uint256).max);
        collCcy.approve(address(pool), type(uint256).max);
        vm.stopPrank();
    }

    /**
     * @notice CORE S1 INVARIANT — NOW A LIVE GUARD (audit task P2 fix landed).
     *
     * The intended property is: neither removeLiquidity nor claim may ever revert
     * due to a reward-arithmetic underflow (lastTrackedLiquidity decrement
     * exceeding the stored value).
     *
     * Originally FALSIFIED (audit finding S1): the principal-credited tracker drifts
     * below the share-value-derived decrement, so the Solidity-0.8 checked
     * subtraction at BasePool.sol:252 reverted with Panic(0x11), locking the LP.
     * The saturating-subtraction fix (audit task P2) now floors the new tracked
     * liquidity at 0 instead of reverting, at BasePool.sol:252 and :437.
     *
     * This invariant is therefore RE-ENABLED (vm.skip removed) and is now a genuine
     * regression guard: with the fix, removeLiquidity never reverts at the reward
     * site, so removeActualRevertSeen must stay false across the fuzz campaign.
     *
     * It asserts the ACTUAL on-chain revert (removeActualRevertSeen, set only when
     * removeLiquidity really reverted with Panic(0x11) at the reward site), NOT the
     * mere arithmetic precondition — the saturating fix makes the call succeed, so
     * the flag stays false and the guard passes.
     */
    function invariant_exitNeverRevertsFromRewardUnderflow() public view {
        assertFalse(
            handler.removeActualRevertSeen(),
            string.concat("S1 reward underflow (actual revert): ", handler.rewardUnderflowContext())
        );
    }

    /**
     * @notice ACTIVE claim-side guard (BasePool.sol:437).
     *
     * The removeLiquidity decrement (line 252) is falsified deterministically
     * above. The CLAIM decrement (line 437) uses the same unguarded pattern
     * (lastTrackedLiquidity - claimInfo.loanAmount) and is theoretically vulnerable,
     * but across the realistic add/remove/borrow/repay/claim/reinvest sequences this
     * harness explores it was NOT reached (claims occur within constant-share
     * intervals whose tracker was set consistently). This invariant runs the full
     * handler campaign and asserts the claim site stays unviolated, acting as a
     * regression guard: if a future change makes the claim underflow reachable,
     * this turns red. The handler flags the site by decoding an arithmetic
     * Panic(0x11) from a reverted claim() (the only user-data-dependent checked
     * subtraction in the claim path).
     */
    function invariant_claimNeverRevertsFromRewardUnderflow() public view {
        assertFalse(
            handler.claimUnderflowSeen(),
            "claim-side reward underflow (BasePool.sol:437) reached - S1 now falsified on claim path too"
        );
    }

    /**
     * @notice DETERMINISTIC replay of the minimal counterexample the invariant
     *         fuzzer originally shrank to (seed 1). Drives the handler through the
     *         exact add/add/warp/remove/add/remove sequence that FALSIFIED S1
     *         pre-fix. With the saturating-subtraction fix (audit task P2) at
     *         BasePool.sol:252, removeLiquidity must now succeed (no Panic(0x11)),
     *         even though the underflow PRECONDITION is still reached
     *         (liquidityRemoved > lastTrackedLiquidity) — the fix floors at 0 rather
     *         than reverting. Self-contained proof that S1 is FIXED on the remove
     *         path, independent of the fuzzer's RNG.
     */
    function test_S1_fixed_deterministic_replay() public {
        handler.addLiquidity(3534, 2);
        handler.addLiquidity(8345, 31);
        handler.warp(30109035684);
        handler.removeLiquidity(3, 1631640016903207799531283960614);
        handler.addLiquidity(
            101617175471035115835688569010101867805699620471168094044354915832100953916851, 6338
        );
        uint256 removesBefore = handler.successfulRemoves();
        handler.removeLiquidity(2281056921148190965963613, 1455021431308021796148);

        // The drift precondition is still reached: the share-value decrement exceeds
        // the principal-credited tracker. Pre-fix this caused the lock.
        assertTrue(
            handler.removeUnderflowPreconditionSeen(),
            "expected the underflow precondition (liquidityRemoved > tracker) to be reached"
        );
        // With the saturating fix, removeLiquidity no longer reverts at line 252:
        // the LP is NOT locked out of its funds.
        assertFalse(
            handler.removeActualRevertSeen(),
            "saturating fix: removeLiquidity must NOT revert with Panic(0x11) at line 252"
        );
        // The final remove must have actually COMPLETED, not merely avoided the
        // line-252 panic: the handler's try/catch swallows every other revert
        // without setting removeActualRevertSeen, so without this assertion the
        // replay could pass vacuously while the LP is still locked.
        assertEq(
            handler.successfulRemoves(),
            removesBefore + 1,
            "final removeLiquidity must complete successfully"
        );
    }

    /**
     * @notice Reward supply conservation (P4): credited + remaining == initial.
     * This guards the MOCK's own bookkeeping (no double-spend / leak in the
     * controller stub). It cannot catch a BasePool over-crediting bug — see the
     * separate non-tautological bound below for that.
     */
    function invariant_rewardSupplyConserved() public view {
        assertEq(
            controller.rewardSupply() + controller.totalDistributed(),
            handler.initialRewardSupply(),
            "reward supply not conserved"
        );
    }

    /**
     * @notice NON-TAUTOLOGICAL over-crediting guard (P4).
     *
     * BasePool feeds `requestTokenDistribution` a `_liquidity` equal to the LP's
     * lastTrackedLiquidity. A correct pool can never pass a liquidity larger than
     * the total loanCcy that has ever ENTERED the pool (LP principal added + loan
     * repayments received) — a tracker only grows from those two sources. If a
     * BasePool accounting bug inflated `_liquidity` beyond this bound, rewards
     * would be over-credited; this invariant catches it. The mock records the
     * largest `_liquidity` it ever received; the handler records the inflow bound.
     */
    function invariant_rewardLiquidityNeverExceedsInflow() public view {
        assertLe(
            controller.maxLiquidityRequested(),
            handler.totalLoanCcyInflow(),
            "reward _liquidity exceeded total loanCcy inflow - possible over-crediting"
        );
    }
}
