// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {BasePool} from "../../contracts/BasePool.sol";
import {IController} from "../../contracts/interfaces/IController.sol";
import {MockRewardController} from "./mocks/MockRewardController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract ReproToken is ERC20 {
    constructor() ERC20("Repro", "RPR") {}
    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title RewardUnderflowReproTest
 * @notice DETERMINISTIC reproduction of audit finding S1: the reward-bookkeeping
 *         non-underflow invariant is FALSIFIED. See
 *         reports/vinuchain-audit-2026-06-10/05-VinuFinance-Backend.md (S1 / A3).
 *
 * VERDICT: FALSIFIED. removeLiquidity reverts with an arithmetic underflow
 * (Panic 0x11) at BasePool.sol:252:
 *
 *     _updateRewardAndSend(_onBehalfOf, lastTrackedLiquidity[_onBehalfOf] - liquidityRemoved)
 *
 * ROOT CAUSE — share-price drift between two accounting systems
 * ------------------------------------------------------------
 * `lastTrackedLiquidity[a]` is credited with the LP's raw PRINCIPAL deposit
 * (BasePool.sol:194: `+ _sendAmount`) and decremented on exit by `liquidityRemoved`
 * (BasePool.sol:252), where (BasePool.sol:244-245):
 *
 *     liquidityRemoved = numShares * (totalLiquidity - minLiquidity) / totalLpShares
 *
 * `liquidityRemoved` is the share-proportional VALUE of the position against the
 * CURRENT pool, which moves as the share price moves (later LPs adding at a
 * different price, and/or accrued interest from repayments). The tracker never
 * moves with it. For an early LP that deposited a small amount, once the pool's
 * per-share value rises, `liquidityRemoved > lastTrackedLiquidity[a]`, and the
 * Solidity-0.8 checked subtraction at line 252 underflows and REVERTS — locking
 * that LP's removeLiquidity. The analogous decrement at BasePool.sol:437 locks
 * `claim` the same way.
 *
 * MINIMAL TRIGGER (no interest required, just multi-LP price movement):
 *   1. LP-small adds a small amount  -> tracker = small.
 *   2. A larger LP adds              -> pool per-share value rises.
 *   3. LP-small removes its shares   -> liquidityRemoved > tracker -> revert at :252.
 *
 * IMPACT: liveness / fund-lock DoS for the affected LP position (NOT theft). The
 * LP cannot remove or claim until pool state shifts enough to make the subtraction
 * valid again, which it may never do.
 *
 * SCOPE NOTE: this is a CHARACTERIZATION test of a known-bad path. It ASSERTS the
 * revert; it does NOT change deployed-contract semantics (audit task scope). A
 * saturating-subtraction fix (audit task P2) at lines 252 and 437 — flooring the
 * new liquidity at 0 — would make this revert a clean exit and is the recommended
 * remediation.
 */
contract RewardUnderflowReproTest is Test {
    BasePool pool;
    MockRewardController controller;
    ReproToken loanCcy;
    ReproToken collCcy;

    // Mirror test/pool.spec.ts constants.
    uint256 constant LOAN_TENOR = 86400;
    uint256 constant MAX_LOAN_PER_COLL = 1;
    uint256 constant LIQUIDITY_BND_1 = 5000;
    uint256 constant LIQUIDITY_BND_2 = 10000;
    uint256 constant MIN_LOAN = 200;
    uint256 constant DECIMALS = 0;
    uint256 constant MIN_LIQUIDITY = 5000;
    uint256 constant CREATOR_FEE = 8;
    uint96 constant REWARD_COEFFICIENT = 1e15;
    uint256 constant R1 = 2 * 1e17;
    uint256 constant R2 = 2 * 1e16;

    address constant LP_SEED = address(0x5EED); // creator who seeds the pool
    address constant LP_SMALL = address(0x5A11); // early small LP that gets locked
    address constant LP_BIG = address(0xB16); // later LP that moves the share price

    function setUp() public {
        vm.warp(1_000_000);
        loanCcy = new ReproToken();
        collCcy = new ReproToken();
        controller = new MockRewardController();
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
            tokens, DECIMALS, LOAN_TENOR, MAX_LOAN_PER_COLL, rs, bnds, MIN_LOAN,
            CREATOR_FEE, MIN_LIQUIDITY, IController(address(controller)), REWARD_COEFFICIENT
        );

        _fund(LP_SEED);
        _fund(LP_SMALL);
        _fund(LP_BIG);
    }

    function _fund(address who) internal {
        loanCcy.mintTo(who, type(uint128).max);
        vm.prank(who);
        loanCcy.approve(address(pool), type(uint256).max);
    }

    /**
     * @notice Minimal 3-LP reproduction (mirrors the invariant fuzzer's shrunk
     *         counterexample). LP_SMALL's removeLiquidity reverts with arithmetic
     *         underflow at BasePool.sol:252 and is locked out of its funds.
     */
    function test_S1_FALSIFIED_removeLiquidity_locks_on_underflow() public {
        // 1. Seed the pool above minLiquidity so the inherited core line-245
        //    underflow (totalLiquidity < minLiquidity) is NOT the cause.
        vm.prank(LP_SEED);
        pool.addLiquidity(LP_SEED, 5002, block.timestamp, 0); // totalLiquidity=5002

        // 2. Early small LP adds a tiny amount. tracker := 31.
        vm.prank(LP_SMALL);
        pool.addLiquidity(LP_SMALL, 31, block.timestamp, 0);
        assertEq(pool.lastTrackedLiquidity(LP_SMALL), 31, "tracker = raw small deposit");

        // 3. The seed LP partially removes. Because the minLiquidity buffer must
        //    stay in the pool, a partial removal returns very little liquidity but
        //    burns many shares -> totalLpShares drops far more than totalLiquidity,
        //    so the per-share value JUMPS. (This is the share-concentration step
        //    the invariant fuzzer found.)
        vm.warp(block.timestamp + 200); // clear MIN_LPING_PERIOD for LP_SEED
        vm.prank(LP_SEED);
        pool.removeLiquidity(LP_SEED, 614);

        // 4. A larger LP adds at the now-elevated share price.
        vm.prank(LP_BIG);
        pool.addLiquidity(LP_BIG, 6338, block.timestamp, 0);

        // 5. Clear MIN_LPING_PERIOD for LP_SMALL.
        vm.warp(block.timestamp + 200);

        // Show the drift: liquidityRemoved for LP_SMALL's shares now exceeds tracker.
        (, , , uint256[] memory sharesOverTime, ) = pool.getLpInfo(LP_SMALL);
        uint128 smallShares = uint128(sharesOverTime[sharesOverTime.length - 1]);
        (, , , , , uint256 totalLiquidity, uint256 totalLpShares, , ) = pool.getPoolInfo();
        uint256 liquidityRemoved = (uint256(smallShares) * (totalLiquidity - MIN_LIQUIDITY)) / totalLpShares;
        uint256 tracked = pool.lastTrackedLiquidity(LP_SMALL);
        emit log_named_uint("LP_SMALL shares", smallShares);
        emit log_named_uint("totalLiquidity", totalLiquidity);
        emit log_named_uint("totalLpShares", totalLpShares);
        emit log_named_uint("liquidityRemoved (decrement)", liquidityRemoved);
        emit log_named_uint("lastTrackedLiquidity (tracker)", tracked);
        assertGt(liquidityRemoved, tracked, "precondition: decrement must exceed tracker");

        // 6. THE LOCK: removeLiquidity reverts with arithmetic underflow at line 252.
        vm.prank(LP_SMALL);
        vm.expectRevert(stdError.arithmeticError);
        pool.removeLiquidity(LP_SMALL, smallShares);
    }
}
