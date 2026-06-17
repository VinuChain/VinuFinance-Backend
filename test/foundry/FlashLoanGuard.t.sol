// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {BasePool} from "../../contracts/BasePool.sol";
import {IBasePool} from "../../contracts/interfaces/IBasePool.sol";
import {IController} from "../../contracts/interfaces/IController.sol";
import {MockRewardController} from "./mocks/MockRewardController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract GuardTestToken is ERC20 {
    constructor() ERC20("Test", "TST") {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title Forwarder
 * @notice Thin attacker/relayer contract so that tx.origin (the calling EOA)
 *         differs from msg.sender (this contract). The pool's flash-loan guard is
 *         keyed by tx.origin, so faithfully exercising it requires
 *         tx.origin != msg.sender — which Foundry does NOT give by default
 *         (vm.prank sets only msg.sender unless vm.startPrank(origin, origin) is used).
 *
 * The Forwarder is the LP/borrower of record (_onBehalfOf == address(this)); it
 * holds the loan/collateral tokens and grants the pool allowance, because
 * addLiquidity/borrow pull funds from msg.sender (== this contract). Several
 * Forwarders driven by ONE EOA model one attacker controlling multiple positions
 * while sharing a single tx.origin-keyed guard entry.
 */
contract Forwarder {
    BasePool public immutable pool;
    IERC20 public immutable loanCcy;
    IERC20 public immutable collCcy;

    constructor(BasePool _pool, IERC20 _loanCcy, IERC20 _collCcy) {
        pool = _pool;
        loanCcy = _loanCcy;
        collCcy = _collCcy;
        // Pre-approve the pool to pull both currencies from this contract.
        _loanCcy.approve(address(_pool), type(uint256).max);
        _collCcy.approve(address(_pool), type(uint256).max);
    }

    function addLiquidity(uint128 amount, uint256 deadline) external {
        pool.addLiquidity(address(this), amount, deadline, 0);
    }

    function removeLiquidity(uint128 numShares) external {
        pool.removeLiquidity(address(this), numShares);
    }

    function borrow(
        uint128 sendAmount,
        uint128 minLoanLimit,
        uint128 maxRepayLimit,
        uint256 deadline
    ) external {
        pool.borrow(address(this), sendAmount, minLoanLimit, maxRepayLimit, deadline, 0);
    }
}

/**
 * @title FlashLoanGuardTest
 * @notice Pins the invariant behind audit finding S5 — the same-block
 *         "add-then-borrow" flash-loan guard in BasePool and the (benign)
 *         clear-key asymmetry.
 *
 * The guard (`lastAddOfTxOrigin`, keyed by tx.origin):
 *   - SET   in _addLiquidity   : lastAddOfTxOrigin[tx.origin] = block.timestamp
 *   - CHECK in borrow          : reverts "Invalid operation." if
 *                                lastAddOfTxOrigin[tx.origin] == block.timestamp
 *   - (formerly) CLEARED in removeLiquidity, but keyed by _onBehalfOf — never
 *     tx.origin. That clear was dead w.r.t. the guard and was removed in S5; this
 *     test pins that removing it changed nothing AND that the guard cannot be
 *     bypassed via remove in the same block as a fresh add.
 *
 * Because the guard stores the CURRENT block.timestamp and is compared against the
 * CURRENT block.timestamp, it auto-expires when the block advances; no explicit
 * clear is required.
 *
 * tx.origin (EOA) != msg.sender (Forwarder) is modelled with vm.startPrank(eoa, eoa).
 */
contract FlashLoanGuardTest is Test {
    BasePool pool;
    MockRewardController controller;
    GuardTestToken loanCcy;
    GuardTestToken collCcy;
    Forwarder fwd; // primary attacker position
    Forwarder aged; // an older position owned by the SAME EOA (removable)

    address constant EOA = address(0xE0A);

    // 18-decimal pool params (mirrors the demo deploy.ts shape) so that loanTerms
    // yields a real, repayable loan for the amounts used below.
    uint256 constant BASE = 1e18;
    uint256 constant LOAN_TENOR = 86400;
    uint256 constant MAX_LOAN_PER_COLL = (15 * BASE) / 10; // 1.5
    uint256 constant R1 = (5 * BASE) / 100; // 5%
    uint256 constant R2 = (2 * BASE) / 100; // 2%
    uint256 constant LIQUIDITY_BND_1 = 10 * BASE;
    uint256 constant LIQUIDITY_BND_2 = 100 * BASE;
    uint256 constant MIN_LOAN = (20 * BASE) / 100; // 0.20
    uint256 constant DECIMALS = 18;
    uint256 constant MIN_LIQUIDITY = 1 * BASE;
    uint256 constant CREATOR_FEE = (15 * BASE) / 1000; // 1.5%
    uint96 constant REWARD_COEFFICIENT = uint96(BASE / 1000);

    // MIN_LPING_PERIOD in BasePool (seconds between add and earliest remove).
    uint256 constant MIN_LPING_PERIOD = 120;

    // Working amounts.
    uint128 constant LIQUIDITY = uint128(40 * BASE);
    uint128 constant COLLATERAL = uint128(8 * BASE);

    function setUp() public {
        // Non-trivial, uint32-safe timestamp.
        vm.warp(1_000_000);

        loanCcy = new GuardTestToken();
        collCcy = new GuardTestToken();
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

        fwd = new Forwarder(pool, IERC20(address(loanCcy)), IERC20(address(collCcy)));
        aged = new Forwarder(pool, IERC20(address(loanCcy)), IERC20(address(collCcy)));

        // Fund both forwarders (each is msg.sender for its pool calls, so it must
        // hold and approve the tokens). Generous supply; allowance set in ctor.
        _fund(address(fwd));
        _fund(address(aged));
    }

    function _fund(address who) internal {
        loanCcy.mintTo(who, type(uint128).max);
        collCcy.mintTo(who, type(uint128).max);
    }

    // Shares minted by the pool for a fresh add into an empty position (matches
    // BasePool._addLiquidity: newLpShares = amount * 1000 / minLiquidity when
    // totalLpShares == 0; for the aged forwarder the pool is non-empty so we read
    // the actual last shares from getLpInfo instead).
    function _lastShares(address who) internal view returns (uint128) {
        (, , , uint256[] memory sharesOverTime, ) = pool.getLpInfo(who);
        return uint128(sharesOverTime[sharesOverTime.length - 1]);
    }

    /**
     * (A) Same-block addLiquidity then borrow by the SAME EOA reverts: the guard is
     *     active. lastAddOfTxOrigin[EOA] == block.timestamp at the borrow.
     */
    function test_A_sameBlock_add_then_borrow_reverts() public {
        vm.startPrank(EOA, EOA); // msg.sender == EOA externally; tx.origin == EOA
        fwd.addLiquidity(LIQUIDITY, block.timestamp);
        vm.expectRevert("Invalid operation.");
        fwd.borrow(COLLATERAL, 0, type(uint128).max, block.timestamp);
        vm.stopPrank();
    }

    /**
     * (B) The crux of S5. One EOA holds an AGED position (added long ago, past
     *     MIN_LPING_PERIOD, so removable now). In the SAME block it:
     *       1. adds fresh liquidity  -> sets lastAddOfTxOrigin[EOA] = block.timestamp
     *       2. removes the AGED position (this SUCCEEDS — earliestRemove long passed)
     *       3. tries to borrow        -> MUST STILL revert ("Invalid operation.")
     *
     *     Step 2 is a genuinely-successful removeLiquidity occurring in the same block
     *     as the fresh add and the borrow attempt. Because the production clear was
     *     keyed by _onBehalfOf (the aged Forwarder), it never touched the EOA's
     *     tx.origin-keyed guard entry, so the borrow still trips the guard. This is
     *     the reachable bypass the asymmetry could have created.
     *
     *     This PASSES today. It FAILS if removeLiquidity is wrongly changed to
     *     `delete lastAddOfTxOrigin[tx.origin]` — then step 2 clears the EOA guard set
     *     by step 1 and the borrow goes through. That regression is exactly what this
     *     test pins against. (Verified by the implementer: temporarily applying the
     *     bad re-key turns this test red.)
     */
    function test_B_sameBlock_freshAdd_removeAged_borrow_still_reverts() public {
        // Seed an aged position for the EOA via the `aged` forwarder, long ago.
        vm.startPrank(EOA, EOA);
        aged.addLiquidity(LIQUIDITY, block.timestamp);
        vm.stopPrank();

        // Advance well past MIN_LPING_PERIOD so the aged position is removable and the
        // aged add's guard entry has expired.
        vm.warp(block.timestamp + MIN_LPING_PERIOD + 1);
        vm.roll(block.number + 1);

        uint128 agedShares = _lastShares(address(aged));

        vm.startPrank(EOA, EOA);
        // 1. Fresh add: sets lastAddOfTxOrigin[EOA] = block.timestamp.
        fwd.addLiquidity(LIQUIDITY, block.timestamp);

        // 2. Remove the AGED position in the SAME block. This SUCCEEDS (earliestRemove
        //    for the aged position passed). With the production code its
        //    `delete lastAddOfTxOrigin[address(aged)]` does NOT touch the EOA key.
        aged.removeLiquidity(agedShares);

        // 3. Borrow in the SAME block MUST STILL revert on the flash-loan guard.
        vm.expectRevert("Invalid operation.");
        fwd.borrow(COLLATERAL, 0, type(uint128).max, block.timestamp);
        vm.stopPrank();
    }

    /**
     * (C) Borrow in a LATER block (timestamp advanced) succeeds: the guard
     *     auto-expires (lastAddOfTxOrigin[EOA] != current block.timestamp), proving
     *     no brick / DoS from the missing clear.
     */
    function test_C_laterBlock_borrow_succeeds() public {
        vm.startPrank(EOA, EOA);
        fwd.addLiquidity(LIQUIDITY, block.timestamp);

        // Advance one block: timestamp moves forward, so the stored guard value (the
        // add's block.timestamp) no longer equals the current one.
        vm.warp(block.timestamp + 1);
        vm.roll(block.number + 1);

        uint256 loanBalBefore = loanCcy.balanceOf(address(fwd));
        fwd.borrow(COLLATERAL, 0, type(uint128).max, block.timestamp);
        uint256 loanBalAfter = loanCcy.balanceOf(address(fwd));
        vm.stopPrank();

        // The borrow actually disbursed loan currency: it did not silently no-op.
        assertGt(loanBalAfter, loanBalBefore, "later-block borrow must disburse a loan");
    }
}
