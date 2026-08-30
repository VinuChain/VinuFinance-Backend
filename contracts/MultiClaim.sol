// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IBasePool} from "./interfaces/IBasePool.sol";

/// @title MultiClaim
/// @author Samuele Marro
/// @notice Allows a user to claim bounded consecutive loan groups in one transaction
contract MultiClaim is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_CLAIM_BATCH = 50;

    /// @notice Claims multiple contracts 
    ///
    /// @dev Groups are still one global consecutive claim prefix: a later group's
    ///      first index must immediately follow the preceding group's last index.
    ///
    /// @param _pool Pool for which to claim
    /// @param _loanIdxs Array of arrays of loan indexes to claim
    /// @param _isReinvested Whether, for each sub-array, the claim should be reinvested
    /// @param _deadline Deadline by which to execute the transaction
    function claimMultiple(
        IBasePool _pool,
        uint256[][] calldata _loanIdxs,
        bool[] calldata _isReinvested,
        uint256 _deadline
    ) external nonReentrant {
        require(_loanIdxs.length > 0, "MultiClaim: Empty loan index array.");
        require(
            _loanIdxs.length == _isReinvested.length,
            "MultiClaim: Inconsistent lengths."
        );
        uint256 totalIndexes;
        for (uint256 i = 0; i < _loanIdxs.length; i++) {
            require(
                _loanIdxs[i].length > 0,
                "MultiClaim: Empty loan index sub-array."
            );
            require(
                _loanIdxs[i].length <= MAX_CLAIM_BATCH - totalIndexes,
                "MultiClaim: Claim batch too large."
            );
            totalIndexes += _loanIdxs[i].length;
            for (uint256 j = 1; j < _loanIdxs[i].length; j++) {
                require(
                    _loanIdxs[i][j - 1] < type(uint256).max &&
                        _loanIdxs[i][j] == _loanIdxs[i][j - 1] + 1,
                    "MultiClaim: Non-consecutive loan indices."
                );
            }
            if (i > 0) {
                uint256 previousLast = _loanIdxs[i - 1][_loanIdxs[i - 1].length - 1];
                require(
                    previousLast < type(uint256).max &&
                        _loanIdxs[i][0] == previousLast + 1,
                    "MultiClaim: Non-consecutive loan indices."
                );
            }
        }

        // The complete nested batch is validated before the first external call
        // so a malformed later group cannot leave an earlier group claimed.
        (IERC20 loanCcyToken, IERC20 collCcyToken, , , , , , , ) = _pool.getPoolInfo();

        uint256 loanCcyBalanceBefore = loanCcyToken.balanceOf(address(this));
        uint256 collCcyBalanceBefore = collCcyToken.balanceOf(address(this));
        
        for (uint256 i = 0; i < _loanIdxs.length; i++) {
            _pool.claim(
                msg.sender,
                _loanIdxs[i],
                _isReinvested[i],
                _deadline
            );
        }

        // Transfer the loan currency to the user
        uint256 loanCcyBalanceAfter = loanCcyToken.balanceOf(address(this));
        uint256 loanCcyBalanceDiff = _exactDelta(loanCcyBalanceBefore, loanCcyBalanceAfter);

        // Transfer the collateral currency to the user
        uint256 collCcyBalanceAfter = collCcyToken.balanceOf(address(this));
        uint256 collCcyBalanceDiff = _exactDelta(collCcyBalanceBefore, collCcyBalanceAfter);

        if (loanCcyBalanceDiff > 0) {
            _transferExact(loanCcyToken, msg.sender, loanCcyBalanceDiff);
        }
        if (collCcyBalanceDiff > 0) {
            _transferExact(collCcyToken, msg.sender, collCcyBalanceDiff);
        }
    }

    function _exactDelta(uint256 _before, uint256 _after) internal pure returns (uint256) {
        require(_after >= _before, "Unsupported token behavior.");
        return _after - _before;
    }

    function _transferExact(IERC20 _token, address _to, uint256 _amount) internal {
        uint256 contractBefore = _token.balanceOf(address(this));
        uint256 recipientBefore = _token.balanceOf(_to);
        _token.safeTransfer(_to, _amount);
        uint256 contractAfter = _token.balanceOf(address(this));
        uint256 recipientAfter = _token.balanceOf(_to);
        require(
            contractBefore >= contractAfter && contractBefore - contractAfter == _amount &&
                recipientAfter >= recipientBefore && recipientAfter - recipientBefore == _amount,
            "Unsupported token behavior."
        );
    }
}
