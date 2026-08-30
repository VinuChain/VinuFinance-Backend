// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {BasePool} from "../../contracts/BasePool.sol";
import {EmergencyWithdrawal} from "../../contracts/EmergencyWithdrawal.sol";
import {IBasePool} from "../../contracts/interfaces/IBasePool.sol";
import {IController} from "../../contracts/interfaces/IController.sol";
import {IPausable} from "../../contracts/interfaces/IPausable.sol";
import {MockRewardController} from "./mocks/MockRewardController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/interfaces/IERC165.sol";

contract P1Token is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract P1ApprovalToken is P1Token {
    bool public failApproval;

    constructor() P1Token("P1 approval token", "P1A") {}

    function setFailApproval(bool fail) external {
        failApproval = fail;
    }

    function approve(address spender, uint256 amount) public override returns (bool) {
        require(!failApproval, "Approval unavailable.");
        return super.approve(spender, amount);
    }
}

contract P1CollateralToken is P1Token {
    constructor() P1Token("P1 collateral", "P1C") {}

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}

contract P1Controller is IController {
    bool public poolsWhitelisted = true;
    bool public failRevenue;
    bool public noOpRevenue;
    bool public partialRevenue;

    function setRevenueMode(bool fail, bool noOp) external {
        failRevenue = fail;
        noOpRevenue = noOp;
    }

    function setPartialRevenue(bool enabled) external {
        partialRevenue = enabled;
    }

    function setPoolWhitelisted(bool enabled) external {
        poolsWhitelisted = enabled;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IController).interfaceId;
    }

    function poolWhitelisted(address) external view returns (bool) {
        return poolsWhitelisted;
    }

    function depositRevenue(IERC20 token, uint256 amount) external payable override {
        require(msg.value == 0, "Native value unsupported.");
        require(!failRevenue, "Revenue unavailable.");
        if (!noOpRevenue) {
            uint256 credited = partialRevenue ? amount / 2 : amount;
            require(token.transferFrom(msg.sender, address(this), credited), "Revenue transfer failed.");
        }
    }

    function requestTokenDistribution(
        address,
        uint128,
        uint32,
        uint96
    ) external override returns (uint256) { return 0; }

    function requestTokenDistributionExact(address, uint256) external override returns (uint256) {
        return 0;
    }

    function pausePool(IPausable pool) external {
        pool.pause();
    }

    function unpausePool(IPausable pool) external {
        pool.unpause();
    }
}

contract P1AccountingTest is Test {
    uint128 constant MIN_LIQUIDITY = 5_000;
    uint256 constant MIN_LOAN = 200;
    uint256 constant LOAN_TENOR = 86_400;
    uint256 constant MAX_LOAN_PER_COLL = 1;
    uint256 constant R1 = 2e17;
    uint256 constant R2 = 2e16;
    uint256 constant BND1 = 5_000;
    uint256 constant BND2 = 10_000;
    uint256 constant CREATOR_FEE = 8;
    uint96 constant REWARD_COEFFICIENT = 1e15;

    address constant LP1 = address(0xA11CE);
    address constant LP2 = address(0xB0B);
    address constant LP3 = address(0xC0FFEE);
    address constant BORROWER = address(0xD00D);

    function _pool(P1Token loan, P1CollateralToken collateral) internal returns (BasePool pool) {
        MockRewardController controller = new MockRewardController();
        pool = _poolWithController(loan, collateral, IController(address(controller)));
    }

    function _poolWithController(
        P1Token loan,
        P1CollateralToken collateral,
        IController controller
    ) internal returns (BasePool pool) {
        pool = _poolWithControllerAndCoefficient(loan, collateral, controller, REWARD_COEFFICIENT);
    }

    function _poolWithControllerAndCoefficient(
        P1Token loan,
        P1CollateralToken collateral,
        IController controller,
        uint96 coefficient
    ) internal returns (BasePool pool) {
        IERC20[] memory tokens = new IERC20[](2);
        tokens[0] = IERC20(address(loan));
        tokens[1] = IERC20(address(collateral));
        uint256[] memory rates = new uint256[](2);
        rates[0] = R1;
        rates[1] = R2;
        uint256[] memory bounds = new uint256[](2);
        bounds[0] = BND1;
        bounds[1] = BND2;
        pool = new BasePool(
            tokens,
            0,
            LOAN_TENOR,
            MAX_LOAN_PER_COLL,
            rates,
            bounds,
            MIN_LOAN,
            CREATOR_FEE,
            MIN_LIQUIDITY,
            controller,
            coefficient
        );
    }

    function _fundAndApprove(P1Token token, address account, uint256 amount, address spender) internal {
        token.mintTo(account, amount);
        vm.startPrank(account);
        token.approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _seedThreeLps(BasePool pool, P1Token loan) internal {
        _fundAndApprove(loan, LP1, 6_001, address(pool));
        _fundAndApprove(loan, LP2, 5_001, address(pool));
        _fundAndApprove(loan, LP3, 5_001, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        vm.prank(LP2);
        pool.addLiquidity(LP2, 5_001, block.timestamp, 0);
        vm.prank(LP3);
        pool.addLiquidity(LP3, 5_001, block.timestamp, 0);
    }

    function test_threeLpNonDivisibleRepaymentConservesEveryToken() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);

        _fundAndApprove(loan, LP1, 6_001, address(pool));
        _fundAndApprove(loan, LP2, 5_001, address(pool));
        _fundAndApprove(loan, LP3, 5_001, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        vm.prank(LP2);
        pool.addLiquidity(LP2, 5_001, block.timestamp, 0);
        vm.prank(LP3);
        pool.addLiquidity(LP3, 5_001, block.timestamp, 0);

        _fundAndApprove(collateral, BORROWER, 10_000, address(pool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment, , , uint128 totalShares, , ) = pool.loanIdxToLoanInfo(1);
        _fundAndApprove(loan, BORROWER, repayment, address(pool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.repay(1, BORROWER);

        uint256 before1 = loan.balanceOf(LP1);
        uint256 before2 = loan.balanceOf(LP2);
        uint256 before3 = loan.balanceOf(LP3);
        vm.prank(LP1);
        pool.claim(LP1, _one(1), false, block.timestamp);
        vm.prank(LP2);
        pool.claim(LP2, _one(1), false, block.timestamp);
        vm.prank(LP3);
        pool.claim(LP3, _one(1), false, block.timestamp);

        uint256 claimed = (loan.balanceOf(LP1) - before1) +
            (loan.balanceOf(LP2) - before2) +
            (loan.balanceOf(LP3) - before3);
        assertEq(totalShares, 3_200);
        assertEq(claimed, repayment, "all repayment units must be claimable");
    }

    function test_threeLpNonDivisibleDefaultConservesCollateralAndLoanTracker() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _seedThreeLps(pool, loan);

        _fundAndApprove(collateral, BORROWER, 10_000, address(pool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (, uint128 loanCollateral, uint128 loanAmount, uint128 totalShares, uint32 expiry, ) =
            pool.loanIdxToLoanInfo(1);
        assertEq(totalShares, 3_200);

        vm.warp(uint256(expiry) + 1);
        uint256 before1 = collateral.balanceOf(LP1);
        uint256 before2 = collateral.balanceOf(LP2);
        uint256 before3 = collateral.balanceOf(LP3);
        uint256 tracker1 = pool.lastTrackedLiquidity(LP1);
        uint256 tracker2 = pool.lastTrackedLiquidity(LP2);
        uint256 tracker3 = pool.lastTrackedLiquidity(LP3);
        vm.prank(LP1);
        pool.claim(LP1, _one(1), false, block.timestamp);
        vm.prank(LP2);
        pool.claim(LP2, _one(1), false, block.timestamp);
        vm.prank(LP3);
        pool.claim(LP3, _one(1), false, block.timestamp);

        uint256 claimed = (collateral.balanceOf(LP1) - before1) +
            (collateral.balanceOf(LP2) - before2) +
            (collateral.balanceOf(LP3) - before3);
        assertEq(claimed, loanCollateral, "all default collateral must be claimable");
        assertEq(pool.claimedLpShares(1), totalShares);
        assertGt(loanAmount, 0);
        assertEq(
            (tracker1 - pool.lastTrackedLiquidity(LP1)) +
                (tracker2 - pool.lastTrackedLiquidity(LP2)) +
                (tracker3 - pool.lastTrackedLiquidity(LP3)),
            loanAmount,
            "loan tracker must conserve the original loan amount"
        );
    }

    function test_claimBatchRejectsSparseDuplicateUnsettledAndIsIdempotent() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _fundAndApprove(loan, LP1, 100_001, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 100_001, block.timestamp, 0);
        _fundAndApprove(collateral, BORROWER, 30_000, address(pool));

        uint256[] memory invalidEmpty = new uint256[](0);
        vm.expectRevert(bytes("Invalid claim batch."));
        vm.prank(LP1);
        pool.claim(LP1, invalidEmpty, false, block.timestamp);

        uint256[] memory tooLarge = new uint256[](51);
        vm.expectRevert(bytes("Invalid claim batch."));
        vm.prank(LP1);
        pool.claim(LP1, tooLarge, false, block.timestamp);

        for (uint256 i = 1; i <= 3; i++) {
            vm.warp(block.timestamp + 1);
            vm.prank(BORROWER);
            pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
            (uint128 repayment, , , , , ) = pool.loanIdxToLoanInfo(i);
            _fundAndApprove(loan, BORROWER, repayment, address(pool));
            vm.warp(block.timestamp + 1);
            vm.prank(BORROWER);
            pool.repay(i, BORROWER);
        }

        uint256[] memory duplicate = new uint256[](2);
        duplicate[0] = 1;
        duplicate[1] = 1;
        vm.expectRevert(bytes("Non-consecutive loan indices."));
        vm.prank(LP1);
        pool.claim(LP1, duplicate, false, block.timestamp);

        uint256[] memory sparse = new uint256[](2);
        sparse[0] = 1;
        sparse[1] = 3;
        vm.expectRevert(bytes("Non-consecutive loan indices."));
        vm.prank(LP1);
        pool.claim(LP1, sparse, false, block.timestamp);

        uint256[] memory outOfRange = _one(4);
        vm.expectRevert(bytes("Invalid claim range."));
        vm.prank(LP1);
        pool.claim(LP1, outOfRange, false, block.timestamp);

        uint256[] memory all = new uint256[](3);
        all[0] = 1;
        all[1] = 2;
        all[2] = 3;
        vm.prank(LP1);
        pool.claim(LP1, all, false, block.timestamp);
        uint256 afterClaim = loan.balanceOf(LP1);
        vm.expectRevert(bytes("Invalid claim range."));
        vm.prank(LP1);
        pool.claim(LP1, all, false, block.timestamp);
        assertEq(loan.balanceOf(LP1), afterClaim, "idempotent claim must not transfer twice");

        // An unsettled loan cannot advance the cursor or claimed-share ledger.
        P1Token secondLoan = new P1Token("P1 second loan", "P1S");
        P1CollateralToken secondCollateral = new P1CollateralToken();
        BasePool secondPool = _pool(secondLoan, secondCollateral);
        _fundAndApprove(secondLoan, LP1, 10_001, address(secondPool));
        vm.prank(LP1);
        secondPool.addLiquidity(LP1, 10_001, block.timestamp, 0);
        _fundAndApprove(secondCollateral, BORROWER, 10_000, address(secondPool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        secondPool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        vm.expectRevert(bytes("Cannot claim with unsettled loan."));
        vm.prank(LP1);
        secondPool.claim(LP1, _one(1), false, block.timestamp);
        assertEq(secondPool.claimedLpShares(1), 0);
    }

    function test_zeroShareIntervalsNormalizeAndReinitialize() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _fundAndApprove(loan, LP1, 30_000, address(pool));
        _fundAndApprove(loan, LP2, 30_000, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        vm.prank(LP2);
        pool.addLiquidity(LP2, 6_001, block.timestamp, 0);
        _fundAndApprove(collateral, BORROWER, 30_000, address(pool));

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment1, , , , , ) = pool.loanIdxToLoanInfo(1);
        _fundAndApprove(loan, BORROWER, repayment1, address(pool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.repay(1, BORROWER);

        vm.warp(block.timestamp + 121);
        (, , , uint256[] memory firstShares, ) = pool.getLpInfo(LP1);
        vm.prank(LP1);
        pool.removeLiquidity(LP1, uint128(firstShares[firstShares.length - 1]));

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment2, , , , , ) = pool.loanIdxToLoanInfo(2);
        _fundAndApprove(loan, BORROWER, repayment2, address(pool));

        vm.prank(LP1);
        pool.claim(LP1, _one(1), false, block.timestamp);
        (uint32 fromAfterZero, , uint32 ptrAfterZero, , ) = pool.getLpInfo(LP1);
        assertEq(fromAfterZero, 3, "zero-share interval must be skipped");
        assertEq(ptrAfterZero, 1, "cursor must normalize the zero-share segment");

        vm.warp(block.timestamp + 1);
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        (fromAfterZero, , ptrAfterZero, , ) = pool.getLpInfo(LP1);
        assertEq(fromAfterZero, 3);
        assertEq(ptrAfterZero, 2);

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment3, , , , , ) = pool.loanIdxToLoanInfo(3);
        _fundAndApprove(loan, BORROWER, repayment3, address(pool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.repay(3, BORROWER);
        vm.prank(LP1);
        pool.claim(LP1, _one(3), false, block.timestamp);
    }

    function test_tinyReinvestClaimPaysDirectlyAndDoesNotInflateTracker() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _fundAndApprove(loan, LP1, 100_001, address(pool));
        _fundAndApprove(loan, LP2, 150, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 100_001, block.timestamp, 0);
        vm.prank(LP2);
        pool.addLiquidity(LP2, 150, block.timestamp, 0);
        _fundAndApprove(collateral, BORROWER, 1_000, address(pool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 1_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment, , uint128 loanAmount, uint128 totalShares, , ) = pool.loanIdxToLoanInfo(1);
        _fundAndApprove(loan, BORROWER, repayment, address(pool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.repay(1, BORROWER);

        (, , , uint256[] memory lp2Shares, ) = pool.getLpInfo(LP2);
        uint128 currentShares = uint128(lp2Shares[lp2Shares.length - 1]);
        uint256 before = loan.balanceOf(LP2);
        uint256 beforeTracker = pool.lastTrackedLiquidity(LP2);
        vm.prank(LP2);
        pool.claim(LP2, _one(1), true, block.timestamp);
        uint256 paid = loan.balanceOf(LP2) - before;
        assertGt(paid, 0);
        assertLt(paid, MIN_LIQUIDITY / 1000);
        (, , , lp2Shares, ) = pool.getLpInfo(LP2);
        assertEq(lp2Shares[lp2Shares.length - 1], currentShares, "tiny reinvest must not mint shares");
        uint256 trackerDelta = (uint256(loanAmount) * currentShares) / totalShares;
        assertEq(pool.lastTrackedLiquidity(LP2), beforeTracker - trackerDelta);
    }

    function test_removeLiquidityUsesFullPrecisionForLargeLiquidity() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _fundAndApprove(loan, LP1, 6_001, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);

        vm.warp(block.timestamp + 121);
        uint256 hugeLiquidity = uint256(1) << 200;
        uint128 hugeShares = uint128(1) << 127;
        uint256 currentBalance = loan.balanceOf(address(pool));
        loan.mintTo(address(pool), hugeLiquidity - currentBalance);

        // Test-only storage setup models a funded pool after long operation.
        // The old `numShares * liquidity` expression overflowed here even
        // though the quotient (all shares) is valid.
        vm.store(address(pool), bytes32(uint256(11)), bytes32(hugeLiquidity));
        vm.store(address(pool), bytes32(uint256(6)), bytes32(uint256(hugeShares)));
        bytes32 lpBase = keccak256(abi.encode(LP1, uint256(18)));
        bytes32 sharesData = keccak256(abi.encode(uint256(lpBase) + 1));
        vm.store(address(pool), bytes32(uint256(lpBase) + 1), bytes32(uint256(1)));
        vm.store(address(pool), sharesData, bytes32(uint256(hugeShares)));

        vm.prank(LP1);
        pool.removeLiquidity(LP1, hugeShares);
        (, , , , , uint256 remainingLiquidity, , , ) = pool.getPoolInfo();
        assertEq(remainingLiquidity, MIN_LIQUIDITY);
        assertEq(loan.balanceOf(LP1), hugeLiquidity - MIN_LIQUIDITY);
    }

    function test_removeLiquidityDoesNotBurnSharesForZeroPayout() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _fundAndApprove(loan, LP1, 6_001, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        vm.warp(block.timestamp + 121);

        (, , , uint256[] memory sharesBefore, ) = pool.getLpInfo(LP1);
        vm.store(address(pool), bytes32(uint256(11)), bytes32(uint256(MIN_LIQUIDITY)));
        vm.expectRevert(bytes("No removable liquidity."));
        vm.prank(LP1);
        pool.removeLiquidity(LP1, uint128(sharesBefore[sharesBefore.length - 1]));

        (, , , uint256[] memory sharesAfter, ) = pool.getLpInfo(LP1);
        assertEq(sharesAfter[sharesAfter.length - 1], sharesBefore[sharesBefore.length - 1]);
    }

    function test_rewardTrackerAdditionSaturatesWithoutBlockingAdd() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _fundAndApprove(loan, LP1, 12_002, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);

        bytes32 trackerSlot = keccak256(abi.encode(LP1, uint256(24)));
        vm.store(
            address(pool),
            trackerSlot,
            bytes32(uint256(type(uint128).max) - 1)
        );

        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        assertEq(pool.lastTrackedLiquidity(LP1), type(uint128).max);
    }

    function test_extremeRewardRequestCannotBlockExit() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        P1Controller controller = new P1Controller();
        BasePool pool = _poolWithControllerAndCoefficient(
            loan,
            collateral,
            IController(address(controller)),
            type(uint96).max
        );
        _fundAndApprove(loan, LP1, 12_002, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);

        // Model a saturated tracker after a long-lived position. The reward
        // product is near the uint256 boundary, but optional reward accounting
        // must not make the next principal transition revert.
        bytes32 trackerSlot = keccak256(abi.encode(LP1, uint256(24)));
        vm.store(address(pool), trackerSlot, bytes32(uint256(type(uint128).max)));
        vm.warp(type(uint32).max - 120);
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        assertGt(pool.pendingRewardDebt(LP1), 0);
    }

    function test_pauseMatrixBlocksAddsAndReinvestClaimsOnly() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        P1Controller controller = new P1Controller();
        BasePool pool = _poolWithController(loan, collateral, IController(address(controller)));
        _seedTwoLps(pool, loan);
        _fundAndApprove(collateral, BORROWER, 20_000, address(pool));

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment1, , , , , ) = pool.loanIdxToLoanInfo(1);
        _fundAndApprove(loan, BORROWER, repayment1, address(pool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.repay(1, BORROWER);

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment2, , , , , ) = pool.loanIdxToLoanInfo(2);
        _fundAndApprove(loan, BORROWER, repayment2, address(pool));

        _fundAndApprove(loan, LP3, MIN_LIQUIDITY + 1, address(pool));
        controller.pausePool(IPausable(address(pool)));
        vm.expectRevert(bytes("Pausable: paused"));
        vm.prank(LP3);
        pool.addLiquidity(LP3, MIN_LIQUIDITY + 1, block.timestamp, 0);

        vm.expectRevert(bytes("Pausable: paused"));
        vm.prank(LP1);
        pool.claim(LP1, _one(1), true, block.timestamp);

        // Non-reinvested claim, repayment, removal and force-reward remain live.
        vm.prank(LP1);
        pool.claim(LP1, _one(1), false, block.timestamp);
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.repay(2, BORROWER);
        vm.prank(LP2);
        pool.forceRewardUpdate(LP2);

        vm.warp(block.timestamp + 121);
        (, , , uint256[] memory shares, ) = pool.getLpInfo(LP1);
        vm.prank(LP1);
        pool.removeLiquidity(LP1, uint128(shares[shares.length - 1]));
    }

    function test_dewhitelistedPoolBlocksNewExposureButSettlementsAndExitsRemainLive() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        P1Controller controller = new P1Controller();
        BasePool pool = _poolWithController(loan, collateral, IController(address(controller)));
        EmergencyWithdrawal emergency = new EmergencyWithdrawal();
        _seedTwoLps(pool, loan);
        _fundAndApprove(collateral, BORROWER, 20_000, address(pool));

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment, , , , , ) = pool.loanIdxToLoanInfo(1);
        _fundAndApprove(loan, BORROWER, repayment, address(pool));

        controller.setPoolWhitelisted(false);

        _fundAndApprove(loan, LP3, MIN_LIQUIDITY + 1, address(pool));
        vm.expectRevert(bytes("Pool is not whitelisted."));
        vm.prank(LP3);
        pool.addLiquidity(LP3, MIN_LIQUIDITY + 1, block.timestamp, 0);

        _fundAndApprove(collateral, BORROWER, 10_000, address(pool));
        vm.expectRevert(bytes("Pool is not whitelisted."));
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.repay(1, BORROWER);

        vm.expectRevert(bytes("Pool is not whitelisted."));
        vm.prank(LP1);
        pool.claim(LP1, _one(1), true, block.timestamp);

        vm.prank(LP1);
        pool.claim(LP1, _one(1), false, block.timestamp);

        vm.warp(1_000_000 + 121);
        (, , , uint256[] memory lp1Shares, ) = pool.getLpInfo(LP1);
        vm.prank(LP1);
        pool.removeLiquidity(LP1, uint128(lp1Shares[lp1Shares.length - 1]));

        vm.prank(LP2);
        pool.setApprovals(address(emergency), 4);
        vm.prank(LP2);
        emergency.approve(address(pool), address(this));
        assertGt(pool.getCurrentLpShares(LP2), 0, "current-share getter must expose the active entitlement");
        emergency.collectEmergency(pool, LP2);
        assertEq(pool.getCurrentLpShares(LP2), 0, "emergency exit must clear current shares");
    }

    function test_pendingRevenueRetriesWithoutInvisiblePoolAssets() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        P1Controller controller = new P1Controller();
        BasePool pool = _poolWithController(loan, collateral, IController(address(controller)));
        _fundAndApprove(loan, LP1, 15_001, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 10_001, block.timestamp, 0);

        controller.setRevenueMode(true, false);
        vm.warp(block.timestamp + 121);
        (, , , uint256[] memory shares, ) = pool.getLpInfo(LP1);
        vm.prank(LP1);
        pool.removeLiquidity(LP1, uint128(shares[shares.length - 1]));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 10_001, block.timestamp, 0);

        uint256 pending = MIN_LIQUIDITY;
        assertEq(pool.pendingRevenue(IERC20(address(loan))), pending);
        assertEq(loan.balanceOf(address(pool)), 10_001 + pending);
        assertEq(loan.allowance(address(pool), address(controller)), 0);

        controller.setRevenueMode(false, false);
        vm.prank(LP2);
        // Permissionless retry does not depend on the original fee payer.
        pool.flushPendingRevenue(IERC20(address(loan)), type(uint256).max);
        assertEq(pool.pendingRevenue(IERC20(address(loan))), 0);
        assertEq(loan.balanceOf(address(controller)), pending);
        assertEq(loan.allowance(address(pool), address(controller)), 0);
        assertEq(loan.balanceOf(address(pool)), 10_001);
    }

    function test_revenueApprovalFailureCannotBlockPrincipalOperation() public {
        vm.warp(1_000_000);
        P1ApprovalToken loan = new P1ApprovalToken();
        P1CollateralToken collateral = new P1CollateralToken();
        P1Controller controller = new P1Controller();
        BasePool pool = _poolWithController(loan, collateral, IController(address(controller)));
        _fundAndApprove(loan, LP1, 15_001, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 10_001, block.timestamp, 0);

        vm.warp(block.timestamp + 121);
        (, , , uint256[] memory shares, ) = pool.getLpInfo(LP1);
        vm.prank(LP1);
        pool.removeLiquidity(LP1, uint128(shares[shares.length - 1]));

        loan.setFailApproval(true);
        vm.prank(LP1);
        pool.addLiquidity(LP1, 10_001, block.timestamp, 0);
        assertEq(pool.pendingRevenue(IERC20(address(loan))), MIN_LIQUIDITY);
        assertEq(loan.balanceOf(address(pool)), 10_001 + MIN_LIQUIDITY);
        assertEq(loan.allowance(address(pool), address(controller)), 0);

        loan.setFailApproval(false);
        pool.flushPendingRevenue(IERC20(address(loan)), type(uint256).max);
        assertEq(pool.pendingRevenue(IERC20(address(loan))), 0);
        assertEq(loan.balanceOf(address(pool)), 10_001);
    }

    function test_partialRevenueFlushTracksActualTransferAndCanRecover() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        P1Controller controller = new P1Controller();
        BasePool pool = _poolWithController(loan, collateral, IController(address(controller)));
        _fundAndApprove(loan, LP1, 15_001, address(pool));

        vm.prank(LP1);
        pool.addLiquidity(LP1, 10_001, block.timestamp, 0);
        controller.setPartialRevenue(true);
        vm.warp(block.timestamp + 121);
        (, , , uint256[] memory shares, ) = pool.getLpInfo(LP1);
        vm.prank(LP1);
        pool.removeLiquidity(LP1, uint128(shares[shares.length - 1]));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 10_001, block.timestamp, 0);

        assertEq(pool.pendingRevenue(IERC20(address(loan))), 2_500);
        assertEq(loan.balanceOf(address(pool)), 12_501);
        assertEq(loan.balanceOf(address(controller)), 2_500);
        assertEq(loan.allowance(address(pool), address(controller)), 0);

        controller.setPartialRevenue(false);
        vm.prank(LP2);
        pool.flushPendingRevenue(IERC20(address(loan)), type(uint256).max);
        assertEq(pool.pendingRevenue(IERC20(address(loan))), 0);
        assertEq(loan.balanceOf(address(pool)), 10_001);
        assertEq(loan.balanceOf(address(controller)), 5_000);
        assertEq(loan.allowance(address(pool), address(controller)), 0);
    }

    function test_delegatedRepayCannotRedirectCollateral() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _seedTwoLps(pool, loan);
        _fundAndApprove(collateral, BORROWER, 10_000, address(pool));

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment, , , , , ) = pool.loanIdxToLoanInfo(1);
        _fundAndApprove(loan, LP1, repayment, address(pool));
        vm.prank(BORROWER);
        pool.setApprovals(LP1, 1);

        vm.warp(block.timestamp + 1);
        vm.expectRevert(bytes("Invalid recipient."));
        vm.prank(LP1);
        pool.repay(1, LP1);

        vm.prank(LP1);
        pool.repay(1, BORROWER);
        (, , , , , bool repaid) = pool.loanIdxToLoanInfo(1);
        assertTrue(repaid);
    }

    function test_repayAtExpiryIsAllowedButDefaultClaimNeedsStrictlyAfter() public {
        vm.warp(1_000_000);
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _seedTwoLps(pool, loan);
        _fundAndApprove(collateral, BORROWER, 20_000, address(pool));

        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (uint128 repayment, , , , uint32 expiry, ) = pool.loanIdxToLoanInfo(1);
        _fundAndApprove(loan, BORROWER, repayment, address(pool));
        vm.warp(uint256(expiry));
        vm.prank(BORROWER);
        pool.repay(1, BORROWER);
        (, , , , , bool repaid) = pool.loanIdxToLoanInfo(1);
        assertTrue(repaid, "repayment at exact expiry must remain valid");

        P1Token secondLoan = new P1Token("P1 second loan", "P1S");
        P1CollateralToken secondCollateral = new P1CollateralToken();
        BasePool secondPool = _pool(secondLoan, secondCollateral);
        _seedTwoLps(secondPool, secondLoan);
        _fundAndApprove(secondCollateral, BORROWER, 10_000, address(secondPool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        secondPool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (, , , , uint32 secondExpiry, ) = secondPool.loanIdxToLoanInfo(1);
        vm.warp(uint256(secondExpiry));
        vm.expectRevert(bytes("Cannot claim with unsettled loan."));
        vm.prank(LP1);
        secondPool.claim(LP1, _one(1), false, block.timestamp);

        vm.warp(uint256(secondExpiry) + 1);
        vm.prank(LP1);
        secondPool.claim(LP1, _one(1), false, block.timestamp);
    }

    function test_timestampCeilingKeepsExistingExitLiveAndRejectsNewAdds() public {
        P1Token loan = new P1Token("P1 loan", "P1L");
        P1CollateralToken collateral = new P1CollateralToken();
        BasePool pool = _pool(loan, collateral);
        _fundAndApprove(loan, LP1, 20_000, address(pool));

        // Deploy both pools while their configured tenor can still fit in the
        // uint32 expiry domain. The boundary below exercises liquidity-time
        // checks on an existing pool, not the constructor's tenor preflight.
        BasePool secondPool = _pool(new P1Token("P1 loan 2", "P1L2"), new P1CollateralToken());
        P1Token secondLoan = P1Token(address(_loanToken(secondPool)));
        _fundAndApprove(secondLoan, LP2, 6_001, address(secondPool));

        vm.warp(type(uint32).max - 120);
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        (, uint32 earliestRemove, , , ) = pool.getLpInfo(LP1);
        assertEq(earliestRemove, type(uint32).max);

        vm.warp(type(uint32).max - 119);
        vm.expectRevert(bytes("Timestamp too large."));
        vm.prank(LP2);
        secondPool.addLiquidity(LP2, 6_001, block.timestamp, 0);

        vm.warp(type(uint32).max);
        vm.prank(LP1);
        pool.forceRewardUpdate(LP1);
        assertEq(pool.lastRewardTimestamp(LP1), type(uint32).max);

        // The capped reward timestamp must not lock principal exits after 2106.
        vm.warp(uint256(type(uint32).max) + 1);
        vm.prank(LP1);
        pool.forceRewardUpdate(LP1);
        vm.prank(LP1);
        pool.removeLiquidity(LP1, 1_200);
    }

    function _loanToken(BasePool pool) internal view returns (IERC20 token) {
        (token, , , , , , , , ) = pool.getPoolInfo();
    }

    function _seedTwoLps(BasePool pool, P1Token loan) internal {
        _fundAndApprove(loan, LP1, 6_001, address(pool));
        _fundAndApprove(loan, LP2, 6_001, address(pool));
        vm.prank(LP1);
        pool.addLiquidity(LP1, 6_001, block.timestamp, 0);
        vm.prank(LP2);
        pool.addLiquidity(LP2, 6_001, block.timestamp, 0);
    }

    function _one(uint256 index) internal pure returns (uint256[] memory indexes) {
        indexes = new uint256[](1);
        indexes[0] = index;
    }
}
