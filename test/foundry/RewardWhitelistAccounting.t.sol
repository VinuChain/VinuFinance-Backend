// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {BasePool} from "../../contracts/BasePool.sol";
import {IController} from "../../contracts/interfaces/IController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC165.sol";

contract RewardWhitelistToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract RewardWhitelistCollateral is RewardWhitelistToken {
    constructor() RewardWhitelistToken("Reward collateral", "RWC") {}

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}

contract ToggleRewardController is IController {
    uint256 constant REWARD_BASE = 10 ** 18;

    bool public whitelisted = true;
    bool public failWhitelistRead;
    uint256 public rewardSupply;
    mapping(address => uint256) public rewardBalance;

    function setWhitelisted(bool enabled) external {
        whitelisted = enabled;
    }

    function setFailWhitelistRead(bool enabled) external {
        failWhitelistRead = enabled;
    }

    function setRewardSupply(uint256 amount) external {
        rewardSupply = amount;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IController).interfaceId;
    }

    function poolWhitelisted(address) external view returns (bool) {
        require(!failWhitelistRead, "Whitelist read failed.");
        return whitelisted;
    }

    function depositRevenue(IERC20, uint256) external payable override {}

    function requestTokenDistribution(address account, uint128 liquidity, uint32 duration, uint96 coefficient)
        external
        override
        returns (uint256 amount)
    {
        require(whitelisted, "Pool is not whitelisted.");
        amount = (uint256(liquidity) * uint256(duration) * uint256(coefficient)) / REWARD_BASE;
        if (amount > rewardSupply) amount = rewardSupply;
        rewardSupply -= amount;
        rewardBalance[account] += amount;
    }

    function requestTokenDistributionExact(address account, uint256 requested)
        external
        override
        returns (uint256 amount)
    {
        require(whitelisted, "Pool is not whitelisted.");
        amount = requested > rewardSupply ? rewardSupply : requested;
        rewardSupply -= amount;
        rewardBalance[account] += amount;
    }

    function collectReward() external returns (uint256 amount) {
        amount = rewardBalance[msg.sender];
        rewardBalance[msg.sender] = 0;
    }
}

contract RewardWhitelistAccountingTest is Test {
    uint256 constant LOAN_TENOR = 86_400;
    uint96 constant REWARD_COEFFICIENT = 1e15;
    address constant ALICE = address(0xA11CE);

    function _newPool(
        RewardWhitelistToken loan,
        RewardWhitelistCollateral collateral,
        ToggleRewardController controller
    ) internal returns (BasePool pool) {
        IERC20[] memory tokens = new IERC20[](2);
        tokens[0] = IERC20(address(loan));
        tokens[1] = IERC20(address(collateral));
        uint256[] memory rates = new uint256[](2);
        rates[0] = 2e17;
        rates[1] = 2e16;
        uint256[] memory bounds = new uint256[](2);
        bounds[0] = 5_000;
        bounds[1] = 10_000;
        pool = new BasePool(
            tokens, 0, LOAN_TENOR, 1, rates, bounds, 200, 0, 5_000, IController(address(controller)), REWARD_COEFFICIENT
        );
    }

    function test_dewhitelistUpdateRewhitelistCannotCreateCollectibleRewardDebt() public {
        vm.warp(1_000_000);
        RewardWhitelistToken loan = new RewardWhitelistToken("Reward loan", "RWL");
        RewardWhitelistCollateral collateral = new RewardWhitelistCollateral();
        ToggleRewardController controller = new ToggleRewardController();
        BasePool pool = _newPool(loan, collateral, controller);

        loan.mintTo(ALICE, 6_000);
        vm.startPrank(ALICE);
        loan.approve(address(pool), type(uint256).max);
        pool.addLiquidity(ALICE, 6_000, block.timestamp, 0);
        vm.stopPrank();

        controller.setWhitelisted(false);
        vm.warp(1_000_100);
        vm.prank(ALICE);
        pool.forceRewardUpdate(ALICE);
        assertEq(pool.pendingRewardDebt(ALICE), 0, "dewhitelist must not create reward debt");
        assertEq(controller.rewardBalance(ALICE), 0);

        // Principal movement remains available while rewards are ineligible.
        vm.warp(1_000_121);
        (,,, uint256[] memory shares,) = pool.getLpInfo(ALICE);
        vm.prank(ALICE);
        pool.removeLiquidity(ALICE, uint128(shares[shares.length - 1]));
        assertGt(loan.balanceOf(ALICE), 0);

        controller.setWhitelisted(true);
        vm.prank(ALICE);
        assertEq(pool.retryPendingReward(ALICE, type(uint256).max), 0);
        vm.prank(ALICE);
        assertEq(controller.collectReward(), 0, "dewhitelisted time must not become collectible");
    }

    function test_unreadableWhitelistPreservesEligibleRewardDebt() public {
        vm.warp(1_000_000);
        RewardWhitelistToken loan = new RewardWhitelistToken("Reward loan", "RWL");
        RewardWhitelistCollateral collateral = new RewardWhitelistCollateral();
        ToggleRewardController controller = new ToggleRewardController();
        BasePool pool = _newPool(loan, collateral, controller);

        loan.mintTo(ALICE, 6_000);
        vm.startPrank(ALICE);
        loan.approve(address(pool), type(uint256).max);
        pool.addLiquidity(ALICE, 6_000, block.timestamp, 0);
        vm.stopPrank();

        controller.setFailWhitelistRead(true);
        vm.warp(1_000_100);
        vm.prank(ALICE);
        pool.forceRewardUpdate(ALICE);
        assertEq(pool.pendingRewardDebt(ALICE), 600, "unreadable eligibility must not erase earned debt");
    }
}
