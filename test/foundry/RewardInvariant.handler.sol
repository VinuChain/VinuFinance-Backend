// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {BasePool} from "../../contracts/BasePool.sol";
import {IBasePool} from "../../contracts/interfaces/IBasePool.sol";
import {MockRewardController} from "./mocks/MockRewardController.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title RewardInvariantHandler
 * @notice Stateful fuzz handler for the S1 reward non-underflow invariant
 *         (audit report 05-VinuFinance-Backend.md, finding S1).
 *
 * The handler drives a single live BasePool through randomized sequences of
 * addLiquidity / removeLiquidity / borrow / repay / claim / reinvest / time
 * advancement across a fixed set of LP and borrower actors, with a NON-ZERO
 * reward coefficient so the reward bookkeeping is fully live.
 *
 * The invariant under scrutiny: the two reward decrements
 *   - removeLiquidity: lastTrackedLiquidity[a] - liquidityRemoved        (BasePool.sol:252)
 *   - claim:           lastTrackedLiquidity[a] - claimInfo.loanAmount     (BasePool.sol:437)
 * must never underflow (Solidity 0.8 checked subtraction would revert and trap
 * the LP's position).
 *
 * Detection strategy (belt-and-suspenders):
 *  1. Every removeLiquidity/claim is invoked through this handler. If the call
 *     reverts with an arithmetic Panic(0x11), we record it and the exact inputs.
 *  2. To distinguish a reward underflow from any *other* arithmetic panic in
 *     those functions, the handler reads lastTrackedLiquidity[a] and recomputes
 *     the decrement BEFORE the call; if decrement > tracked, the violating path
 *     is flagged directly via `rewardUnderflowSeen`.
 */
contract RewardInvariantHandler is Test {
    BasePool public pool;
    MockRewardController public controller;
    IERC20 public loanCcy;
    IERC20 public collCcy;

    address[] public lps;
    address[] public borrowers;

    uint256 public constant MIN_LIQUIDITY = 5000;
    uint256 public constant LOAN_TENOR = 86400;

    // Tracks loan indices that exist (1-based, like the pool).
    uint256 public nextLoanIdxSeen = 1;

    // --- ghost / detection state ---
    // Human-readable context of the most recent S1-relevant event.
    string public rewardUnderflowContext;
    // Per-site flags so each S1 decrement (removeLiquidity:252, claim:437) can be
    // guarded independently.
    // *PreconditionSeen: the arithmetic condition for an underflow was true before
    //   the call (used by the deterministic characterization/replay tests). NOTE:
    //   this is exactly the condition a saturating fix is meant to TOLERATE, so it
    //   must NOT be the basis of a guard that should pass post-fix.
    // *ActualRevertSeen: the call ACTUALLY reverted with arithmetic Panic(0x11) at
    //   the reward site (line 245 proven safe first). This is what a real guard
    //   asserts against: a saturating fix flips it to false.
    bool public removeUnderflowPreconditionSeen; // BasePool.sol:252 precondition
    bool public removeActualRevertSeen; // BasePool.sol:252 real revert
    bool public claimUnderflowSeen; // BasePool.sol:437 real revert
    // Separately tracks the inherited-core line-245 underflow
    // (totalLiquidity < minLiquidity on partial removal) for visibility; this is
    // a pre-existing MYSO-core property, intentionally NOT folded into S1.
    bool public coreLine245UnderflowSeen;
    // counters for coverage visibility
    uint256 public callsAdd;
    uint256 public callsRemove;
    uint256 public callsBorrow;
    uint256 public callsRepay;
    uint256 public callsClaim;
    uint256 public callsWarp;
    uint256 public successfulRemoves;
    uint256 public successfulClaims;

    // cumulative reward funding for conservation checks
    uint256 public initialRewardSupply;
    // Total loanCcy that has ever ENTERED the pool: LP principal added + loan
    // repayments received. A tracker (lastTrackedLiquidity) can only ever grow
    // from an add (+_sendAmount) or a reinvested repayment (+claimInfo.repayments),
    // both of which are bounded by this total. So no single LP's tracker — and
    // hence no `_liquidity` the pool feeds the controller — may exceed it. This is
    // a SOUND upper bound, used to catch reward over-crediting (non-tautological).
    uint256 public totalLoanCcyInflow;

    constructor(
        BasePool _pool,
        MockRewardController _controller,
        IERC20 _loanCcy,
        IERC20 _collCcy,
        address[] memory _lps,
        address[] memory _borrowers
    ) {
        pool = _pool;
        controller = _controller;
        loanCcy = _loanCcy;
        collCcy = _collCcy;
        lps = _lps;
        borrowers = _borrowers;
        initialRewardSupply = _controller.rewardSupply();
    }

    function _lp(uint256 seed) internal view returns (address) {
        return lps[seed % lps.length];
    }

    function _borrower(uint256 seed) internal view returns (address) {
        return borrowers[seed % borrowers.length];
    }

    // Advance time by a bounded amount, keeping block.timestamp within uint32.
    function warp(uint256 secondsToAdvance) external {
        callsWarp++;
        secondsToAdvance = bound(secondsToAdvance, 1, 200000);
        uint256 newTs = block.timestamp + secondsToAdvance;
        // Keep within uint32 to satisfy the pool's uint32(block.timestamp) asserts.
        if (newTs > type(uint32).max - 1) {
            newTs = block.timestamp + 1;
        }
        vm.warp(newTs);
    }

    function addLiquidity(uint256 lpSeed, uint128 amount) external {
        callsAdd++;
        address lp = _lp(lpSeed);
        // Keep the pool above minLiquidity at all times so the inherited core
        // line-245 underflow (totalLiquidity < minLiquidity) cannot mask the
        // reward path under scrutiny. The very first add to an empty pool must
        // therefore be >= minLiquidity; later adds may be small.
        (, , , , , uint256 totalLiquidity, , , ) = pool.getPoolInfo();
        uint256 lo = totalLiquidity < MIN_LIQUIDITY ? MIN_LIQUIDITY : (MIN_LIQUIDITY / 1000);
        amount = uint128(bound(amount, lo, 1_000_000));
        vm.prank(lp);
        try pool.addLiquidity(lp, amount, block.timestamp, 0) {
            totalLoanCcyInflow += amount;
        } catch {}
    }

    function removeLiquidity(uint256 lpSeed, uint128 numShares) external {
        callsRemove++;
        address lp = _lp(lpSeed);

        // Pre-compute the reward decrement to detect a *reward* underflow
        // independently of the call's own revert reason.
        (, , , uint256[] memory sharesOverTime, ) = pool.getLpInfo(lp);
        if (sharesOverTime.length == 0) {
            vm.prank(lp);
            try pool.removeLiquidity(lp, numShares) {} catch {}
            return;
        }
        uint256 currShares = sharesOverTime[sharesOverTime.length - 1];
        if (currShares == 0) {
            return;
        }
        numShares = uint128(bound(numShares, 1, currShares));

        // Classify the two distinct underflow sites BEFORE the call. Returns true
        // when the line-252 reward decrement would underflow AND the inherited
        // core line-245 subtraction is proven safe (so a Panic from the call below
        // is attributable to line 252, not line 245).
        bool rewardSiteWouldUnderflow = _checkRemoveDecrement(lp, numShares);

        vm.prank(lp);
        try pool.removeLiquidity(lp, numShares) {
            successfulRemoves++;
        } catch (bytes memory reason) {
            // Record the ACTUAL revert only when it is an arithmetic Panic(0x11)
            // and the precondition pins it to the reward site (line 252). This is
            // the flag a real guard asserts against: a saturating fix at line 252
            // makes this call succeed, flipping the flag to false.
            if (rewardSiteWouldUnderflow && _isArithmeticPanic(reason)) {
                removeActualRevertSeen = true;
                rewardUnderflowContext = "removeLiquidity:252 actual Panic(0x11) underflow";
            }
        }
    }

    function borrow(uint256 borrowerSeed, uint128 collAmount) external {
        callsBorrow++;
        address b = _borrower(borrowerSeed);
        collAmount = uint128(bound(collAmount, 1, 1_000_000));
        vm.prank(b);
        try pool.borrow(b, collAmount, 0, type(uint128).max, block.timestamp, 0) {
            // a new loan was created
            nextLoanIdxSeen++;
        } catch {}
    }

    function repay(uint256 loanSeed, uint256 borrowerSeed) external {
        callsRepay++;
        address b = _borrower(borrowerSeed);
        uint256 loanIdx = bound(loanSeed, 1, nextLoanIdxSeen == 0 ? 1 : nextLoanIdxSeen);
        // loanIdxToLoanInfo returns (repayment, collateral, loanAmount, totalLpShares, expiry, repaid)
        (uint128 repayment, , , , , ) = pool.loanIdxToLoanInfo(loanIdx);
        vm.prank(b);
        try pool.repay(loanIdx, b) {
            // The repayment (principal + interest) now sits in the pool and can be
            // claimed/reinvested into a tracker, so it counts toward the inflow bound.
            totalLoanCcyInflow += repayment;
        } catch {}
    }

    function claim(uint256 lpSeed, uint256 startLoan, uint256 count, bool reinvest) external {
        callsClaim++;
        address lp = _lp(lpSeed);
        if (nextLoanIdxSeen <= 1) return;
        startLoan = bound(startLoan, 1, nextLoanIdxSeen - 1);
        count = bound(count, 1, 5);

        uint256[] memory idxs = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            idxs[i] = startLoan + i;
        }

        vm.prank(lp);
        try pool.claim(lp, idxs, reinvest, block.timestamp) {
            successfulClaims++;
        } catch (bytes memory reason) {
            // For claim, the only user-data-dependent CHECKED subtraction is the
            // reward decrement at BasePool.sol:437 (the rest of the claim path uses
            // unchecked increments / guarded divisions). An arithmetic Panic(0x11)
            // here is therefore attributable to the S1 reward bookkeeping.
            _flagClaimArithmeticPanic(reason);
        }
    }

    // --- detection helpers ---

    /**
     * @return rewardSiteWouldUnderflow true iff the line-252 reward decrement
     *         would underflow AND the inherited core line-245 subtraction is safe
     *         (so a subsequent Panic from removeLiquidity is attributable to 252).
     */
    function _checkRemoveDecrement(address lp, uint128 numShares) internal returns (bool) {
        // getPoolInfo() returns (loanCcy, collCcy, maxLoanPerColl, minLoan,
        // loanTenor, totalLiquidity, totalLpShares, rewardCoefficient, loanIdx)
        (, , , , , uint256 totalLiquidity, uint256 totalLpShares, , ) = pool.getPoolInfo();
        if (totalLpShares == 0) return false;

        // SITE 1 (inherited MYSO core, BasePool.sol:245): (totalLiquidity - minLiquidity)
        // underflows when totalLiquidity < minLiquidity. This is NOT the S1 reward bug;
        // recorded separately so it never inflates the S1 verdict.
        if (totalLiquidity < MIN_LIQUIDITY) {
            coreLine245UnderflowSeen = true;
            return false; // line 252 is unreachable when line 245 reverts first
        }

        // SITE 2 (reward delta, BasePool.sol:252): lastTrackedLiquidity - liquidityRemoved.
        // Recompute liquidityRemoved exactly as BasePool.sol:244-245 does.
        uint256 liquidityRemoved = (uint256(numShares) * (totalLiquidity - MIN_LIQUIDITY)) / totalLpShares;
        uint256 tracked = pool.lastTrackedLiquidity(lp);
        if (liquidityRemoved > tracked) {
            // Precondition only: this is the arithmetic state a saturating fix is
            // meant to tolerate. Used by the deterministic characterization test,
            // NOT by the post-fix guard.
            removeUnderflowPreconditionSeen = true;
            rewardUnderflowContext = "removeLiquidity:252 liquidityRemoved > lastTrackedLiquidity";
            return true;
        }
        return false;
    }

    function _isArithmeticPanic(bytes memory reason) internal pure returns (bool) {
        // Solidity Panic(uint256) selector is 0x4e487b71; arithmetic code is 0x11.
        if (reason.length != 36) return false;
        bytes4 selector;
        uint256 code;
        assembly {
            selector := mload(add(reason, 0x20))
            code := mload(add(reason, 0x24))
        }
        return selector == 0x4e487b71 && code == 0x11;
    }

    function _flagClaimArithmeticPanic(bytes memory reason) internal {
        if (_isArithmeticPanic(reason)) {
            claimUnderflowSeen = true;
            rewardUnderflowContext = "claim:437 lastTrackedLiquidity - claimInfo.loanAmount underflow";
        }
    }
}
