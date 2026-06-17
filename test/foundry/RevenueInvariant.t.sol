// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {Controller} from "../../contracts/Controller.sol";
import {RevenueInvariantHandler} from "./RevenueInvariant.handler.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract TestToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mintTo(address to, uint256 amount) external { _mint(to, amount); }
}

contract RevenueInvariantTest is Test {
    Controller controller;
    TestToken revenueToken;
    TestToken voteToken;
    RevenueInvariantHandler handler;

    uint256 constant THRESH = 5000;
    uint256 constant SNAPSHOT_EVERY = 100;
    uint256 constant LOCK_PERIOD = 10;

    function setUp() public {
        vm.warp(1_000_000);
        revenueToken = new TestToken("Rev", "REV");
        voteToken = new TestToken("Vote", "VOTE");

        controller = new Controller(
            IERC20(address(voteToken)),
            THRESH, THRESH, THRESH, THRESH,
            SNAPSHOT_EVERY, LOCK_PERIOD,
            address(this)
        );

        address[] memory actors = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            actors[i] = address(uint160(0x3000 + i));
            revenueToken.mintTo(actors[i], type(uint128).max);
            voteToken.mintTo(actors[i], type(uint128).max);
            vm.startPrank(actors[i]);
            revenueToken.approve(address(controller), type(uint256).max);
            voteToken.approve(address(controller), type(uint256).max);
            vm.stopPrank();
        }

        handler = new RevenueInvariantHandler(controller, IERC20(address(revenueToken)), IERC20(address(voteToken)), actors);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.depositRevenue.selector;
        selectors[1] = handler.depositVote.selector;
        selectors[2] = handler.withdrawVote.selector;
        selectors[3] = handler.forceSnapshot.selector;
        selectors[4] = handler.claim.selector;
        selectors[5] = handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function _unclaimedInSnapshots() internal view returns (uint256 sum) {
        uint256 n = controller.numTokenSnapshots(IERC20(address(revenueToken)));
        for (uint256 i = 0; i < n; i++) {
            (, uint256 collected, uint256 claimed, , ) = controller.getTokenSnapshot(IERC20(address(revenueToken)), i);
            assertLe(claimed, collected, "claimedRevenue exceeds collectedRevenue in a snapshot");
            sum += collected - claimed;
        }
    }

    function invariant_revenueConserved() public view {
        uint256 bal = revenueToken.balanceOf(address(controller));
        uint256 current = controller.currentRevenue(IERC20(address(revenueToken)));
        assertEq(bal, current + _unclaimedInSnapshots(), "revenue not conserved");
    }
}
