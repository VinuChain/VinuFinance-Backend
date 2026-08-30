// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IController.sol";

// This mock appears to be a Controller, but actually reverts on all calls

contract MockFakeController is IController {
    constructor () {
        // Ignore everything
    }

    function supportsInterface(bytes4 interfaceId) override external view returns (bool) {
        return
            interfaceId == type(IERC165).interfaceId ||
            interfaceId == type(IController).interfaceId;
    }

    function depositRevenue(IERC20 _token, uint256 _amount) override external payable {
        revert();
    }
    function requestTokenDistribution(address _account, uint128 _liquidity, uint32 _duration, uint96 _rewardCoefficient) override external returns (uint256) {
        _account; _liquidity; _duration; _rewardCoefficient;
        revert();
    }
    function requestTokenDistributionExact(address _account, uint256 _amount) override external returns (uint256) {
        _account; _amount;
        revert();
    }
}
