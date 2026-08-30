// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IBasePool} from "./interfaces/IBasePool.sol";

/// @title MultiClaim
/// @author Samuele Marro
/// @notice Allows a user to claim multiple non-consecutive loans in a single transaction
contract MultiClaim is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Claims multiple contracts 
    ///
    /// @dev Calling with [[1, 2], 3] and [1, 0] will claim loan indexes 1 and 2 (reinvesting)
    ///      and then claim loan index 3 (not reinvesting)
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
        (IERC20 loanCcyToken, IERC20 collCcyToken, , , , , , , ) = _pool.getPoolInfo();

        uint256 loanCcyBalanceBefore = loanCcyToken.balanceOf(address(this));
        uint256 collCcyBalanceBefore = collCcyToken.balanceOf(address(this));
        
        for (uint256 i = 0; i < _loanIdxs.length; i++) {
            require(
                _loanIdxs[i].length > 0,
                "MultiClaim: Empty loan index sub-array."
            );
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
