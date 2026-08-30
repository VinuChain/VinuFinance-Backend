// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {Controller} from "../../contracts/Controller.sol";
import {BasePool} from "../../contracts/BasePool.sol";
import {IController} from "../../contracts/interfaces/IController.sol";
import {IPausable} from "../../contracts/interfaces/IPausable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RevenueP1Token is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SpoofPool is IPausable {
    IController public poolController;
    bool public paused;

    constructor(IController controller) {
        poolController = controller;
    }

    function pause() external override { paused = true; }
    function unpause() external override { paused = false; }
}

contract P1ControllerAccountingTest is Test {
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant CAROL = address(0xC0FFEE);

    function _newController(RevenueP1Token vote) internal returns (Controller controller) {
        controller = new Controller(
            IERC20(address(vote)),
            5000,
            5000,
            5000,
            5000,
            100,
            0,
            address(this)
        );
    }

    function _newPool(RevenueP1Token loan, RevenueP1Token collateral, Controller controller)
        internal
        returns (BasePool pool)
    {
        pool = BasePool(controller.createPool(
            type(BasePool).creationCode,
            _poolConstructorArgs(loan, collateral, controller)
        ));
        assertTrue(controller.poolRegistered(address(pool)));
    }

    function _poolConstructorArgs(
        RevenueP1Token loan,
        RevenueP1Token collateral,
        Controller controller
    ) internal pure returns (bytes memory) {
        IERC20[] memory tokens = new IERC20[](2);
        tokens[0] = IERC20(address(loan));
        tokens[1] = IERC20(address(collateral));
        uint256[] memory rates = new uint256[](2);
        rates[0] = 2e17;
        rates[1] = 2e16;
        uint256[] memory bounds = new uint256[](2);
        bounds[0] = 5_000;
        bounds[1] = 10_000;
        return abi.encode(
            tokens,
            uint256(18),
            uint256(86_400),
            uint256(1),
            rates,
            bounds,
            uint256(200),
            uint256(0),
            uint256(5_000),
            address(controller),
            uint96(1e18)
        );
    }

    function _voteFor(Controller controller, RevenueP1Token vote, IPausable target, uint256 amount) internal {
        vote.mintTo(ALICE, amount);
        vm.startPrank(ALICE);
        vote.approve(address(controller), type(uint256).max);
        controller.depositVoteToken(amount);
        controller.createProposal(target, IController.Action.WHITELIST, block.timestamp + 100);
        vm.stopPrank();
    }

    function test_revenueSnapshotCumulativeFloorConservesDustAcrossVoters() public {
        vm.warp(1_000_000);
        RevenueP1Token vote = new RevenueP1Token("Vote", "VOTE");
        RevenueP1Token revenue = new RevenueP1Token("Revenue", "REV");
        Controller controller = _newController(vote);

        address[3] memory voters = [ALICE, BOB, CAROL];
        for (uint256 i = 0; i < voters.length; i++) {
            vote.mintTo(voters[i], 1);
            vm.startPrank(voters[i]);
            vote.approve(address(controller), type(uint256).max);
            controller.depositVoteToken(1);
            vm.stopPrank();
        }
        revenue.mintTo(address(this), 10);
        revenue.approve(address(controller), type(uint256).max);
        controller.depositRevenue(IERC20(address(revenue)), 10);

        uint256[3] memory before;
        for (uint256 i = 0; i < voters.length; i++) {
            before[i] = revenue.balanceOf(voters[i]);
            vm.prank(voters[i]);
            controller.claimToken(IERC20(address(revenue)), 0, 0);
        }

        uint256 paid = 0;
        for (uint256 i = 0; i < voters.length; i++) {
            paid += revenue.balanceOf(voters[i]) - before[i];
        }
        assertEq(paid, 10, "cumulative floors must allocate every revenue unit");
        (, uint256 collected, uint256 claimed, , ) = controller.getTokenSnapshot(IERC20(address(revenue)), 0);
        assertEq(collected, 10);
        assertEq(claimed, collected);
        assertEq(controller.claimedVoteWeight(IERC20(address(revenue)), 0, address(0)), 3);
    }

    function test_claimMultiplePreflightIsAtomicAndCapped() public {
        vm.warp(1_000_000);
        RevenueP1Token vote = new RevenueP1Token("Vote", "VOTE");
        RevenueP1Token revenue = new RevenueP1Token("Revenue", "REV");
        Controller controller = _newController(vote);
        vote.mintTo(ALICE, 1);
        revenue.mintTo(address(this), 20);
        vm.startPrank(ALICE);
        vote.approve(address(controller), type(uint256).max);
        controller.depositVoteToken(1);
        vm.stopPrank();
        revenue.approve(address(controller), type(uint256).max);
        controller.depositRevenue(IERC20(address(revenue)), 10);

        IERC20[] memory tokens = new IERC20[](2);
        tokens[0] = IERC20(address(revenue));
        tokens[1] = IERC20(address(revenue));
        uint256[] memory tokenSnapshots = new uint256[](2);
        uint256[] memory accountSnapshots = new uint256[](2);
        vm.expectRevert(bytes("Already claimed."));
        vm.prank(ALICE);
        controller.claimMultiple(tokens, tokenSnapshots, accountSnapshots);
        assertFalse(controller.hasClaimedSnapshot(IERC20(address(revenue)), 0, ALICE));

        IERC20[] memory tooManyTokens = new IERC20[](51);
        uint256[] memory tooManySnapshotIndexes = new uint256[](51);
        uint256[] memory tooManyAccountIndexes = new uint256[](51);
        vm.expectRevert(bytes("Claim batch too large."));
        vm.prank(ALICE);
        controller.claimMultiple(tooManyTokens, tooManySnapshotIndexes, tooManyAccountIndexes);
    }

    function test_whitelistRequiresActualBoundBasePool() public {
        vm.warp(1_000_000);
        RevenueP1Token vote = new RevenueP1Token("Vote", "VOTE");
        RevenueP1Token loan = new RevenueP1Token("Loan", "LOAN");
        RevenueP1Token collateral = new RevenueP1Token("Collateral", "COLL");
        Controller controller = _newController(vote);
        BasePool pool = _newPool(loan, collateral, controller);

        _voteFor(controller, vote, IPausable(address(pool)), 100);
        vm.prank(ALICE);
        controller.vote(0);
        controller.setVetoHolderApproval(0, true);
        assertTrue(controller.poolWhitelisted(address(pool)));

        Controller otherController = _newController(new RevenueP1Token("Other", "OTHER"));
        SpoofPool spoof = new SpoofPool(otherController);
        _voteFor(controller, vote, IPausable(address(spoof)), 100);
        vm.prank(ALICE);
        controller.vote(1);
        vm.expectRevert(bytes("Pool not created by Controller."));
        controller.setVetoHolderApproval(1, true);
        assertFalse(controller.poolWhitelisted(address(spoof)));

        _voteFor(controller, vote, IPausable(address(0xBEEF)), 100);
        vm.prank(ALICE);
        controller.vote(2);
        vm.expectRevert(bytes("Invalid pool target."));
        controller.setVetoHolderApproval(2, true);
    }

    function test_factoryRejectsNonCanonicalCodeAndWrongController() public {
        RevenueP1Token vote = new RevenueP1Token("Vote", "VOTE");
        RevenueP1Token loan = new RevenueP1Token("Loan", "LOAN");
        RevenueP1Token collateral = new RevenueP1Token("Collateral", "COLL");
        Controller controller = _newController(vote);

        vm.expectRevert(bytes("Invalid pool creation code."));
        controller.createPool(hex"00", bytes(""));

        Controller otherController = _newController(new RevenueP1Token("Other", "OTHER"));
        vm.expectRevert(bytes("Invalid pool controller."));
        controller.createPool(
            type(BasePool).creationCode,
            _poolConstructorArgs(loan, collateral, otherController)
        );
    }

    function test_whitelistRejectsSameRuntimeWithPreloadedControllerStorage() public {
        vm.warp(1_000_000);
        RevenueP1Token vote = new RevenueP1Token("Vote", "VOTE");
        RevenueP1Token loan = new RevenueP1Token("Loan", "LOAN");
        RevenueP1Token collateral = new RevenueP1Token("Collateral", "COLL");
        Controller controller = _newController(vote);
        BasePool pool = _newPool(loan, collateral, controller);

        address spoof = address(0x51504F4F4C);
        // Model custom init code that returns the exact production runtime but
        // preloads the poolController storage slot without running BasePool's
        // constructor. This is the case runtime-hash validation cannot prove.
        vm.etch(spoof, address(pool).code);
        vm.store(spoof, bytes32(uint256(3)), bytes32(uint256(uint160(address(controller)))));
        assertEq(spoof.codehash, address(pool).codehash);
        assertEq(address(BasePool(spoof).poolController()), address(controller));
        assertFalse(controller.poolRegistered(spoof));

        _voteFor(controller, vote, IPausable(spoof), 100);
        vm.prank(ALICE);
        controller.vote(0);
        vm.expectRevert(bytes("Pool not created by Controller."));
        controller.setVetoHolderApproval(0, true);
        assertFalse(controller.poolWhitelisted(spoof));
    }

    function test_vetoApprovalEpochInvalidatesAtoBtoAAndZeroRemainsLive() public {
        vm.warp(1_000_000);
        RevenueP1Token vote = new RevenueP1Token("Vote", "VOTE");
        RevenueP1Token loan = new RevenueP1Token("Loan", "LOAN");
        RevenueP1Token collateral = new RevenueP1Token("Collateral", "COLL");
        Controller controller = _newController(vote);
        BasePool pool = _newPool(loan, collateral, controller);

        vote.mintTo(ALICE, 40);
        vote.mintTo(CAROL, 60);
        vm.startPrank(ALICE);
        vote.approve(address(controller), type(uint256).max);
        controller.depositVoteToken(40);
        vm.stopPrank();
        vm.startPrank(CAROL);
        vote.approve(address(controller), type(uint256).max);
        controller.depositVoteToken(60);
        vm.stopPrank();
        vm.startPrank(ALICE);
        controller.createProposal(IPausable(address(pool)), IController.Action.WHITELIST, block.timestamp + 100);
        controller.vote(0);
        vm.stopPrank();
        controller.setVetoHolderApproval(0, true);

        controller.transferVetoPower(BOB, false);
        vm.prank(BOB);
        controller.transferVetoPower(address(this), false);
        vm.startPrank(CAROL);
        controller.vote(0);
        vm.stopPrank();
        assertFalse(controller.poolWhitelisted(address(pool)));
        controller.setVetoHolderApproval(0, true);
        assertTrue(controller.poolWhitelisted(address(pool)));

        // Deliberately removing the veto holder keeps the whitelist action live
        // without requiring an approval that no address can provide.
        Controller zeroController = _newController(vote);
        BasePool zeroPool = _newPool(loan, collateral, zeroController);
        zeroController.transferVetoPower(address(0), true);
        vote.mintTo(ALICE, 100);
        vm.startPrank(ALICE);
        vote.approve(address(zeroController), type(uint256).max);
        zeroController.depositVoteToken(100);
        zeroController.createProposal(IPausable(address(zeroPool)), IController.Action.WHITELIST, block.timestamp + 100);
        zeroController.vote(0);
        vm.stopPrank();
        assertTrue(zeroController.poolWhitelisted(address(zeroPool)));
    }

    function test_rewardDebtReportsPartialCreditAndCanRetryAfterFunding() public {
        vm.warp(1_000_000);
        RevenueP1Token vote = new RevenueP1Token("Vote", "VOTE");
        RevenueP1Token loan = new RevenueP1Token("Loan", "LOAN");
        RevenueP1Token collateral = new RevenueP1Token("Collateral", "COLL");
        Controller controller = _newController(vote);
        BasePool pool = _newPool(loan, collateral, controller);

        _voteFor(controller, vote, IPausable(address(pool)), 100);
        vm.prank(ALICE);
        controller.vote(0);
        controller.setVetoHolderApproval(0, true);

        loan.mintTo(ALICE, 6_000);
        vm.startPrank(ALICE);
        loan.approve(address(pool), type(uint256).max);
        pool.addLiquidity(ALICE, 6_000, block.timestamp, 0);
        vm.stopPrank();

        vm.warp(1_000_100);
        vm.prank(ALICE);
        pool.forceRewardUpdate(ALICE);
        uint256 debt = pool.pendingRewardDebt(ALICE);
        assertEq(debt, 600_000);

        vote.mintTo(address(this), 100);
        vote.approve(address(controller), type(uint256).max);
        controller.depositRewardSupply(100);
        assertEq(pool.retryPendingReward(ALICE, 200), 100);
        assertEq(pool.pendingRewardDebt(ALICE), debt - 100);
    }
}
