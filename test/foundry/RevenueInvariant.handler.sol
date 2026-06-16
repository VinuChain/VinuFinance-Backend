// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {Controller} from "../../contracts/Controller.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RevenueInvariantHandler is Test {
    Controller public controller;
    IERC20 public revenueToken;
    IERC20 public voteToken;
    address[] public actors;

    uint256 public totalRevenueDeposited;
    uint256 public callsDeposit;
    uint256 public callsClaim;
    uint256 public successfulClaims;

    constructor(Controller _controller, IERC20 _revenueToken, IERC20 _voteToken, address[] memory _actors) {
        controller = _controller; revenueToken = _revenueToken; voteToken = _voteToken; actors = _actors;
    }

    function _actor(uint256 seed) internal view returns (address) { return actors[seed % actors.length]; }

    function warp(uint256 secondsToAdvance) external {
        secondsToAdvance = bound(secondsToAdvance, 1, 200000);
        vm.warp(block.timestamp + secondsToAdvance);
    }

    function depositRevenue(uint256 actorSeed, uint256 amount) external {
        callsDeposit++;
        address a = _actor(actorSeed);
        amount = bound(amount, 1, 1_000_000);
        vm.prank(a);
        try controller.depositRevenue(revenueToken, amount) { totalRevenueDeposited += amount; } catch {}
    }

    function depositVote(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        amount = bound(amount, 1, 1_000_000);
        vm.prank(a);
        try controller.depositVoteToken(amount) {} catch {}
    }

    function withdrawVote(uint256 actorSeed, uint256 amount) external {
        address a = _actor(actorSeed);
        amount = bound(amount, 1, 1_000_000);
        vm.prank(a);
        try controller.withdrawVoteToken(amount) {} catch {}
    }

    function forceSnapshot() external {
        try controller.forceTokenSnapshotCheck(revenueToken) {} catch {}
    }

    function claim(uint256 actorSeed, uint256 tokenSnapIdx, uint256 acctSnapIdx) external {
        callsClaim++;
        address a = _actor(actorSeed);
        uint256 nTok = controller.numTokenSnapshots(revenueToken);
        uint256 nAcct = controller.numAccountSnapshots(a);
        if (nTok == 0 || nAcct == 0) return;
        tokenSnapIdx = bound(tokenSnapIdx, 0, nTok - 1);
        acctSnapIdx = bound(acctSnapIdx, 0, nAcct - 1);
        vm.prank(a);
        try controller.claimToken(revenueToken, tokenSnapIdx, acctSnapIdx) { successfulClaims++; } catch {}
    }
}
