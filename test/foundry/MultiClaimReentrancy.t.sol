// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {MultiClaim} from "../../contracts/MultiClaim.sol";
import {IBasePool} from "../../contracts/interfaces/IBasePool.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DummyToken is ERC20 {
    constructor() ERC20("Dummy", "DUM") {}
    function mintTo(address to, uint256 amount) external { _mint(to, amount); }
}

contract ReentrantPoolStub {
    IERC20 public loanCcy;
    IERC20 public collCcy;
    MultiClaim public multiClaim;
    constructor(IERC20 _loanCcy, IERC20 _collCcy) { loanCcy = _loanCcy; collCcy = _collCcy; }
    function setMultiClaim(MultiClaim _mc) external { multiClaim = _mc; }
    function getPoolInfo()
        external view
        returns (IERC20, IERC20, uint256, uint256, uint256, uint256, uint256, uint96, uint256)
    { return (loanCcy, collCcy, 0, 0, 0, 0, 0, 0, 0); }
    function claim(address, uint256[] calldata, bool, uint256) external {
        uint256[][] memory idxs = new uint256[][](1);
        idxs[0] = new uint256[](1);
        idxs[0][0] = 1;
        bool[] memory reinvest = new bool[](1);
        reinvest[0] = false;
        multiClaim.claimMultiple(IBasePool(address(this)), idxs, reinvest, block.timestamp);
    }
}

contract MultiClaimReentrancyTest is Test {
    MultiClaim multiClaim;
    ReentrantPoolStub stub;
    DummyToken loanCcy;
    DummyToken collCcy;
    function setUp() public {
        loanCcy = new DummyToken();
        collCcy = new DummyToken();
        multiClaim = new MultiClaim();
        stub = new ReentrantPoolStub(IERC20(address(loanCcy)), IERC20(address(collCcy)));
        stub.setMultiClaim(multiClaim);
    }
    function test_claimMultiple_blocks_reentrancy() public {
        uint256[][] memory idxs = new uint256[][](1);
        idxs[0] = new uint256[](1);
        idxs[0][0] = 1;
        bool[] memory reinvest = new bool[](1);
        reinvest[0] = false;
        vm.expectRevert(bytes("ReentrancyGuard: reentrant call"));
        multiClaim.claimMultiple(IBasePool(address(stub)), idxs, reinvest, block.timestamp);
    }
}
