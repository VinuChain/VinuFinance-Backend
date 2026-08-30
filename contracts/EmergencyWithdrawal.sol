// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./interfaces/IBasePool.sol";

/// @title EmergencyWithdrawal
/// @author Samuele Marro
/// @notice Allows an escrow to withdraw on behalf of a user in case of emergency
contract EmergencyWithdrawal is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Emitted when a user approves an escrow to withdraw on its behalf
    ///
    /// @param user User that approved the escrow
    /// @param pool Pool that the user approved the escrow for
    /// @param escrow Escrow that the user approved
    event Approved(
        address indexed user,
        address indexed pool,
        address indexed escrow
    );

    /// @notice Emitted when a user unapproves an escrow to withdraw on its behalf
    ///
    /// @param user User that unapproved the escrow
    /// @param pool Pool that the user unapproved the escrow for
    /// @param escrow Escrow that the user unapproved
    event Unapproved(
        address indexed user,
        address indexed pool,
        address indexed escrow
    );

    /// @notice Emitted when an escrow withdraws on behalf of a user
    ///
    /// @param user User that the escrow withdrew on behalf of
    /// @param pool Pool that the escrow withdrew from
    /// @param escrow Escrow that withdrew
    /// @param token Token that was withdrawn
    /// @param amount Amount of tokens withdrawn
    event Withdrawal(
        address indexed user,
        address indexed pool,
        address indexed escrow,
        IERC20 token,
        uint256 amount
    );

    // Mapping of user => pool => escrow => approved
    mapping(address => mapping(address => mapping(address => bool)))
        private approved;

    /// @notice Approve an escrow to withdraw on behalf of the user
    ///
    /// @param _pool Pool that the escrow is approved for
    /// @param _escrow Escrow that is approved
    function approve(address _pool, address _escrow) external {
        approved[msg.sender][_pool][_escrow] = true;
        emit Approved(msg.sender, _pool, _escrow);
    }

    /// @notice Unapprove an escrow to withdraw on behalf of the user
    ///
    /// @param _pool Pool that the escrow is unapproved for
    /// @param _escrow Escrow that is unapproved
    function unapprove(address _pool, address _escrow) external {
        approved[msg.sender][_pool][_escrow] = false;
        emit Unapproved(msg.sender, _pool, _escrow);
    }

    /// @notice Returns true if an escrow is approved to withdraw on behalf of the user from a given pool
    ///
    /// @param _user User to check
    /// @param _pool Pool to check
    /// @param _escrow Escrow to check
    function isApproved(
        address _user,
        address _pool,
        address _escrow
    ) public view returns (bool) {
        return approved[_user][_pool][_escrow];
    }

    /// @notice Withdraws the user's currently removable liquidity and returns it to the user
    ///
    /// @dev This function is only callable by an escrow that has been approved by the user
    ///      Note that this means that unless a user approves itself, it cannot withdraw its own funds
    ///      through this contract (which is intended behavior)
    /// @param _pool Pool to withdraw from
    /// @param _onBehalfOf User to withdraw for
    function collectEmergency(
        IBasePool _pool,
        address _onBehalfOf
    ) external nonReentrant {
        require(
            isApproved(_onBehalfOf, address(_pool), msg.sender),
            "Not approved"
        );

        // Consume the helper approval before the first external call. If any
        // later operation reverts, EVM atomicity restores this approval and
        // rolls back the event as well; a successful withdrawal is one-shot.
        approved[_onBehalfOf][address(_pool)][msg.sender] = false;
        emit Unapproved(_onBehalfOf, address(_pool), msg.sender);

        (IERC20 token, , , , , , , , ) = _pool.getPoolInfo();

        // Store the amount of tokens before the withdraw
        uint256 amountBefore = token.balanceOf(address(this));

        // Read only the current entitlement. Full LP history can be attacker-grown
        // and is unnecessary for an emergency exit.
        uint256 currentShares = _pool.getCurrentLpShares(_onBehalfOf);
        require(currentShares <= type(uint128).max, "Shares too large");
        uint128 shares = uint128(currentShares);
        require(shares > 0, "No shares");

        // Withdraw all shares
        _pool.removeLiquidity(_onBehalfOf, shares);

        // Store the amount of tokens after the withdrawal
        uint256 amountAfter = token.balanceOf(address(this));

        // Calculate the amount of tokens to transfer
        require(amountAfter >= amountBefore, "Unsupported token behavior.");
        uint256 amount = amountAfter - amountBefore;

        // A zero-liquidity removal has no output and must not invoke an
        // arbitrary token callback. Any nonzero output is checked exactly on
        // both sides of the transfer.
        if (amount > 0) {
            uint256 escrowBeforeTransfer = amountAfter;
            uint256 userBefore = token.balanceOf(_onBehalfOf);
            token.safeTransfer(_onBehalfOf, amount);
            uint256 escrowAfter = token.balanceOf(address(this));
            uint256 userAfter = token.balanceOf(_onBehalfOf);
            require(
                escrowBeforeTransfer >= escrowAfter && escrowBeforeTransfer - escrowAfter == amount &&
                    userAfter >= userBefore && userAfter - userBefore == amount,
                "Unsupported token behavior."
            );
        }

        emit Withdrawal(_onBehalfOf, address(_pool), msg.sender, token, amount);
    }
}
