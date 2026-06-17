// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {Controller} from "../../contracts/Controller.sol";
import {TestToken} from "./RevenueInvariant.t.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Deterministic companion to the revenue-conservation invariant: proves the
// claim/payout branch is actually reachable (a claim pays out, claimedRevenue
// becomes non-zero) and that the conservation identity holds both after a
// deposit and after a real claim. Guarantees the invariant is not vacuously
// true on a zero-activity campaign.
contract RevenueClaimTest is Test {
    Controller controller;
    TestToken revenueToken;
    TestToken voteToken;
    address alice = address(0xA11CE);

    function setUp() public {
        vm.warp(1_000_000);
        revenueToken = new TestToken("Rev", "REV");
        voteToken = new TestToken("Vote", "VOTE");
        controller = new Controller(
            IERC20(address(voteToken)),
            5000, 5000, 5000, 5000,
            100, 10,
            address(this)
        );
        revenueToken.mintTo(alice, 1_000_000);
        voteToken.mintTo(alice, 1_000_000);
        vm.startPrank(alice);
        revenueToken.approve(address(controller), type(uint256).max);
        voteToken.approve(address(controller), type(uint256).max);
        vm.stopPrank();
    }

    function _accountedRevenue() internal view returns (uint256 acct) {
        uint256 current = controller.currentRevenue(IERC20(address(revenueToken)));
        uint256 unclaimed;
        uint256 n = controller.numTokenSnapshots(IERC20(address(revenueToken)));
        for (uint256 i = 0; i < n; i++) {
            (, uint256 c, uint256 cl, , ) = controller.getTokenSnapshot(IERC20(address(revenueToken)), i);
            unclaimed += c - cl;
        }
        acct = current + unclaimed;
    }

    function test_claim_paysOut_and_conservationHolds() public {
        vm.prank(alice);
        controller.depositVoteToken(1_000_000); // account snapshot 0, balance>0

        uint256 rev = 500;
        vm.prank(alice);
        controller.depositRevenue(IERC20(address(revenueToken)), rev); // first token snapshot

        assertEq(revenueToken.balanceOf(address(controller)), _accountedRevenue(), "conservation broken after deposit");
        assertEq(revenueToken.balanceOf(address(controller)), rev, "controller should hold deposited revenue");

        uint256 before = revenueToken.balanceOf(alice);
        vm.prank(alice);
        controller.claimToken(IERC20(address(revenueToken)), 0, 0);
        uint256 paid = revenueToken.balanceOf(alice) - before;

        assertGt(paid, 0, "claim paid out nothing");
        assertEq(paid, rev, "sole holder should receive full revenue");

        assertEq(revenueToken.balanceOf(address(controller)), _accountedRevenue(), "conservation broken after claim");

        (, uint256 collected, uint256 claimed, , ) = controller.getTokenSnapshot(IERC20(address(revenueToken)), 0);
        assertEq(claimed, collected, "claimed should equal collected after full claim");
        assertGt(claimed, 0, "claimedRevenue stayed zero");
    }
}
