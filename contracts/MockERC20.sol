// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRevenueReentryController {
    function depositRevenue(IERC20 _token, uint256 _amount) external payable;
    function forceTokenSnapshotCheck(IERC20 _token) external;
}

contract MockERC20 is ERC20 {
    constructor() ERC20("MockERC20", "MERC") {
    }

    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }
}

contract MockZeroDecimalERC20 is ERC20 {
    constructor() ERC20("MockZeroDecimalERC20", "M0ERC") {}

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }
}

contract MockDecimalsERC20 is ERC20 {
    uint8 private immutable tokenDecimals;

    constructor(uint8 decimals_) ERC20("MockDecimalsERC20", "MDEC") {
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }

    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }
}

contract FeeOnTransferMockERC20 is ERC20 {
    uint256 public constant FEE_BPS = 1000;
    uint256 public constant BPS_BASE = 10000;

    constructor() ERC20("FeeOnTransferMockERC20", "FMERC") {
    }

    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 fee = amount * FEE_BPS / BPS_BASE;
        super._transfer(from, to, amount - fee);
        if (fee > 0) {
            _burn(from, fee);
        }
    }
}

contract ReentrantRevenueMockERC20 is ERC20 {
    IRevenueReentryController public controller;
    uint256 public reentrantAmount;
    bool public reenter;
    bool public forceSnapshot;
    bool private entered;

    constructor() ERC20("ReentrantRevenueMockERC20", "RMERC") {
    }

    function mint(uint256 amount) external {
        _mint(msg.sender, amount);
    }

    function fundReentrantBalance(uint256 amount) external {
        _mint(address(this), amount);
    }

    function configureReentry(IRevenueReentryController _controller, uint256 _reentrantAmount) external {
        controller = _controller;
        reentrantAmount = _reentrantAmount;
        _approve(address(this), address(_controller), type(uint256).max);
    }

    function setReenter(bool _reenter) external {
        reenter = _reenter;
    }

    function setForceSnapshot(bool _forceSnapshot) external {
        forceSnapshot = _forceSnapshot;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (reenter && !entered && address(controller) != address(0)) {
            entered = true;
            if (forceSnapshot) {
                controller.forceTokenSnapshotCheck(IERC20(address(this)));
            } else {
                controller.depositRevenue(IERC20(address(this)), reentrantAmount);
            }
            entered = false;
        }

        super._transfer(from, to, amount);
    }
}
