// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {Controller} from "../../contracts/Controller.sol";
import {TestToken} from "./RevenueInvariant.t.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FeeOnTransferToken is ERC20 {
    uint256 public constant FEE_BPS = 1_000;
    uint256 public constant BPS_BASE = 10_000;

    constructor() ERC20("Fee Revenue", "FREV") {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = (amount * FEE_BPS) / BPS_BASE;
        super._transfer(from, to, amount - fee);
        if (fee > 0) {
            _burn(from, fee);
        }
    }
}

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

    function test_feeOnTransferRevenueClaimsActualReceivedAmount() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        feeToken.mintTo(alice, 1_000);

        vm.startPrank(alice);
        feeToken.approve(address(controller), type(uint256).max);
        controller.depositVoteToken(1_000_000); // account snapshot 0, balance > 0
        controller.depositRevenue(IERC20(address(feeToken)), 100); // first token snapshot
        vm.stopPrank();

        assertEq(feeToken.balanceOf(address(controller)), 90, "controller should receive net revenue");

        (, uint256 collected, , , ) = controller.getTokenSnapshot(IERC20(address(feeToken)), 0);
        assertEq(collected, 90, "snapshot should account for net received revenue");

        uint256 before = feeToken.balanceOf(alice);
        vm.prank(alice);
        controller.claimToken(IERC20(address(feeToken)), 0, 0);
        uint256 paid = feeToken.balanceOf(alice) - before;

        assertEq(paid, 81, "claim transfer applies the token fee once");
        (, uint256 collectedAfterClaim, uint256 claimed, , ) = controller.getTokenSnapshot(IERC20(address(feeToken)), 0);
        assertEq(collectedAfterClaim, 90, "collected accounting should stay at net deposit");
        assertEq(claimed, 90, "claimed accounting should settle the gross net deposit");
        assertEq(feeToken.balanceOf(address(controller)), 0, "controller should not retain revenue dust");
    }
}
