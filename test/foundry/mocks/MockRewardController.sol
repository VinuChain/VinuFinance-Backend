// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC165.sol";
import {IController} from "../../../contracts/interfaces/IController.sol";

/**
 * @title MockRewardController
 * @notice Minimal IController stub for the Foundry reward-invariant harness.
 *
 * It mirrors the *reward-relevant* arithmetic of the production Controller
 * (`Controller.sol:576-596`): a saturating distribution from a finite
 * `rewardSupply` into per-account `rewardBalance`, using
 * `amount = liquidity * duration * coefficient / REWARD_BASE`.
 *
 * It deliberately does NOT model governance/whitelisting so the harness can
 * exercise the BasePool reward bookkeeping in isolation. `requestTokenDistribution`
 * succeeds (does not revert) so the pool's try/catch swallow path is NOT what
 * keeps the test green — any reward-arithmetic underflow surfaces in BasePool itself.
 */
contract MockRewardController is IController {
    uint256 constant REWARD_BASE = 10 ** 18;

    uint256 public rewardSupply;
    mapping(address => uint256) public rewardBalance;

    // Cumulative amount actually credited (for conservation checks).
    uint256 public totalDistributed;
    // Number of distribution requests serviced.
    uint256 public distributionCalls;
    // Largest single `_liquidity` argument BasePool ever passed in. Used to catch
    // an over-crediting bug where BasePool feeds a liquidity value larger than any
    // LP could legitimately have (non-tautological reward sanity check).
    uint256 public maxLiquidityRequested;

    function setRewardSupply(uint256 _amount) external {
        rewardSupply = _amount;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IController).interfaceId;
    }

    function depositRevenue(IERC20, uint256) external payable override {
        // No-op: revenue accounting is out of scope for the reward invariant.
    }

    function requestTokenDistribution(
        address _account,
        uint128 _liquidity,
        uint32 _duration,
        uint96 _rewardCoefficient
    ) external override {
        distributionCalls++;
        if (uint256(_liquidity) > maxLiquidityRequested) {
            maxLiquidityRequested = uint256(_liquidity);
        }
        uint256 amount = (uint256(_liquidity) * uint256(_duration) * uint256(_rewardCoefficient)) / REWARD_BASE;
        if (amount > rewardSupply) {
            amount = rewardSupply;
        }
        unchecked {
            rewardSupply -= amount;
        }
        rewardBalance[_account] += amount;
        totalDistributed += amount;
    }
}
