// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {BasePool} from "../../contracts/BasePool.sol";
import {Controller} from "../../contracts/Controller.sol";
import {MockFakeController} from "../../contracts/MockFakeController.sol";
import {IBasePool} from "../../contracts/interfaces/IBasePool.sol";
import {IController} from "../../contracts/interfaces/IController.sol";
import {IPausable} from "../../contracts/interfaces/IPausable.sol";
import {MockRewardController} from "./mocks/MockRewardController.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SafetyToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mintTo(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ZeroDecimalSafetyToken is SafetyToken {
    constructor(string memory name_, string memory symbol_) SafetyToken(name_, symbol_) {}

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}

contract MetadataSafetyToken is SafetyToken {
    uint8 private immutable tokenDecimals;

    constructor(uint8 decimals_) SafetyToken("Metadata", "META") {
        tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return tokenDecimals;
    }
}

contract ToggleFeeSafetyToken is SafetyToken {
    bool public feeEnabled;

    constructor(string memory name_, string memory symbol_) SafetyToken(name_, symbol_) {}

    function setFeeEnabled(bool enabled) external {
        feeEnabled = enabled;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (!feeEnabled) {
            super._transfer(from, to, amount);
            return;
        }
        uint256 fee = amount / 10;
        super._transfer(from, to, amount - fee);
        if (fee > 0) _burn(from, fee);
    }
}

contract RecipientFeeSafetyToken is SafetyToken {
    bool public feeEnabled;

    constructor(string memory name_, string memory symbol_) SafetyToken(name_, symbol_) {}

    function setFeeEnabled(bool enabled) external {
        feeEnabled = enabled;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (feeEnabled) {
            uint256 fee = amount / 10;
            if (fee > 0) _burn(to, fee);
        }
    }
}

contract ShortSafetyToken is SafetyToken {
    constructor(string memory name_, string memory symbol_) SafetyToken(name_, symbol_) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount / 2);
    }
}

contract ShortZeroSafetyToken is ZeroDecimalSafetyToken {
    constructor(string memory name_, string memory symbol_) ZeroDecimalSafetyToken(name_, symbol_) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount / 2);
    }
}

contract ToggleFeeZeroSafetyToken is ToggleFeeSafetyToken {
    constructor(string memory name_, string memory symbol_) ToggleFeeSafetyToken(name_, symbol_) {}

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}

contract RebaseSafetyToken is SafetyToken {
    bool public rebaseEnabled;

    constructor(string memory name_, string memory symbol_) SafetyToken(name_, symbol_) {}

    function setRebaseEnabled(bool enabled) external {
        rebaseEnabled = enabled;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (rebaseEnabled) _mint(to, 1);
    }
}

contract CallbackSafetyToken is SafetyToken {
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackEnabled;
    bool private entered;

    constructor(string memory name_, string memory symbol_) SafetyToken(name_, symbol_) {}

    function configureCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function setCallbackEnabled(bool enabled) external {
        callbackEnabled = enabled;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        super._transfer(from, to, amount);
        if (callbackEnabled && !entered) {
            entered = true;
            (bool success, ) = callbackTarget.call(callbackData);
            entered = false;
            require(success, "callback reentry");
        }
    }
}

contract PausableSafetyTarget is IPausable {
    bool public paused;

    function pause() external override {
        paused = true;
    }

    function unpause() external override {
        paused = false;
    }
}

contract FundSafetyTest is Test {
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

    address constant LP = address(0xA11CE);
    address constant BORROWER = address(0xB0B);

    function _pool(IERC20 loan, IERC20 collateral, IController controller, uint256 collDecimals)
        internal
        returns (BasePool pool)
    {
        pool = new BasePool(
            _tokens(loan, collateral),
            collDecimals,
            LOAN_TENOR,
            MAX_LOAN_PER_COLL,
            _rates(),
            _bounds(),
            MIN_LOAN,
            CREATOR_FEE,
            MIN_LIQUIDITY,
            controller,
            REWARD_COEFFICIENT
        );
    }

    function _poolWith(
        IERC20 loan,
        IERC20 collateral,
        IController controller,
        uint256 collDecimals,
        uint256 tenor,
        uint256 minLoan
    ) internal returns (BasePool pool) {
        pool = new BasePool(
            _tokens(loan, collateral),
            collDecimals,
            tenor,
            MAX_LOAN_PER_COLL,
            _rates(),
            _bounds(),
            minLoan,
            CREATOR_FEE,
            MIN_LIQUIDITY,
            controller,
            REWARD_COEFFICIENT
        );
    }

    function _tokens(IERC20 loan, IERC20 collateral) internal pure returns (IERC20[] memory tokens) {
        tokens = new IERC20[](2);
        tokens[0] = loan;
        tokens[1] = collateral;
    }

    function _rates() internal pure returns (uint256[] memory rates) {
        rates = new uint256[](2);
        rates[0] = R1;
        rates[1] = R2;
    }

    function _bounds() internal pure returns (uint256[] memory bounds) {
        bounds = new uint256[](2);
        bounds[0] = BND1;
        bounds[1] = BND2;
    }

    function _approveAndFund(SafetyToken token, address account, uint256 amount, address spender) internal {
        token.mintTo(account, amount);
        vm.prank(account);
        token.approve(spender, type(uint256).max);
    }

    function test_initialLiquidityStrictReserve_fullExitAndReinit() public {
        SafetyToken loan = new SafetyToken("Loan", "LOAN");
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        MockRewardController controller = new MockRewardController();
        BasePool pool = _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(controller)), 0);
        _approveAndFund(loan, LP, MIN_LIQUIDITY * 3, address(pool));

        vm.startPrank(LP);
        vm.expectRevert(bytes("Initial liquidity must exceed minimum."));
        pool.addLiquidity(LP, MIN_LIQUIDITY, block.timestamp, 0);
        vm.expectRevert(bytes("Initial liquidity must exceed minimum."));
        pool.addLiquidity(LP, MIN_LIQUIDITY - 1, block.timestamp, 0);
        pool.addLiquidity(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);
        vm.stopPrank();

        (, , , uint256[] memory shares, ) = pool.getLpInfo(LP);
        uint128 fullExitShares = uint128(shares[shares.length - 1]);
        vm.warp(block.timestamp + 121);
        uint256 balanceBefore = loan.balanceOf(LP);
        vm.prank(LP);
        pool.removeLiquidity(LP, fullExitShares);
        assertEq(loan.balanceOf(LP) - balanceBefore, 1, "minimum reserve must stay locked");
        (, , , , , uint256 liquidityAfterExit, uint256 sharesAfterExit, , ) = pool.getPoolInfo();
        assertEq(liquidityAfterExit, MIN_LIQUIDITY);
        assertEq(sharesAfterExit, 0);

        vm.prank(LP);
        pool.addLiquidity(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);
        (, , , , , uint256 liquidityAfterReinit, uint256 sharesAfterReinit, , ) = pool.getPoolInfo();
        assertEq(liquidityAfterReinit, MIN_LIQUIDITY + 1);
        assertEq(sharesAfterReinit, 1000);
    }

    function test_reentrancyAndExactAddDeltas_rejectCallbackShortAndRebase() public {
        MockRewardController controller = new MockRewardController();

        ShortSafetyToken shortLoan = new ShortSafetyToken("Short", "SHORT");
        ZeroDecimalSafetyToken coll = new ZeroDecimalSafetyToken("Collateral", "COLL");
        BasePool shortPool = _pool(IERC20(address(shortLoan)), IERC20(address(coll)), IController(address(controller)), 0);
        _approveAndFund(shortLoan, LP, MIN_LIQUIDITY * 2, address(shortPool));
        vm.prank(LP);
        vm.expectRevert(bytes("Unsupported token behavior."));
        shortPool.addLiquidity(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);

        RebaseSafetyToken rebasingLoan = new RebaseSafetyToken("Rebase", "REB");
        BasePool rebasePool = _pool(IERC20(address(rebasingLoan)), IERC20(address(coll)), IController(address(controller)), 0);
        _approveAndFund(rebasingLoan, LP, MIN_LIQUIDITY * 2, address(rebasePool));
        rebasingLoan.setRebaseEnabled(true);
        vm.prank(LP);
        vm.expectRevert(bytes("Unsupported token behavior."));
        rebasePool.addLiquidity(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);

        CallbackSafetyToken callbackLoan = new CallbackSafetyToken("Callback", "CALL");
        BasePool callbackPool = _pool(IERC20(address(callbackLoan)), IERC20(address(coll)), IController(address(controller)), 0);
        _approveAndFund(callbackLoan, LP, MIN_LIQUIDITY * 2, address(callbackPool));
        callbackLoan.configureCallback(
            address(callbackPool),
            abi.encodeWithSelector(BasePool.addLiquidity.selector, LP, uint128(MIN_LIQUIDITY + 1), block.timestamp, 0)
        );
        callbackLoan.setCallbackEnabled(true);
        vm.prank(LP);
        vm.expectRevert();
        callbackPool.addLiquidity(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);
    }

    function test_exactOutboundDelta_rejectsFeeAndRebaseOnExit() public {
        MockRewardController controller = new MockRewardController();
        ToggleFeeSafetyToken feeLoan = new ToggleFeeSafetyToken("Fee", "FEE");
        ZeroDecimalSafetyToken coll = new ZeroDecimalSafetyToken("Collateral", "COLL");
        BasePool pool = _pool(IERC20(address(feeLoan)), IERC20(address(coll)), IController(address(controller)), 0);
        _approveAndFund(feeLoan, LP, MIN_LIQUIDITY * 4, address(pool));
        vm.prank(LP);
        pool.addLiquidity(LP, MIN_LIQUIDITY * 3, block.timestamp, 0);
        feeLoan.setFeeEnabled(true);
        vm.warp(block.timestamp + 121);
        (, , , uint256[] memory shares, ) = pool.getLpInfo(LP);
        vm.prank(LP);
        vm.expectRevert(bytes("Unsupported token behavior."));
        pool.removeLiquidity(LP, uint128(shares[shares.length - 1]));

        RecipientFeeSafetyToken recipientFeeLoan = new RecipientFeeSafetyToken("Recipient fee", "RFEE");
        BasePool recipientFeePool = _pool(
            IERC20(address(recipientFeeLoan)),
            IERC20(address(coll)),
            IController(address(controller)),
            0
        );
        _approveAndFund(recipientFeeLoan, LP, MIN_LIQUIDITY * 4, address(recipientFeePool));
        vm.prank(LP);
        recipientFeePool.addLiquidity(LP, MIN_LIQUIDITY * 3, block.timestamp, 0);
        recipientFeeLoan.setFeeEnabled(true);
        vm.warp(block.timestamp + 121);
        (, , , shares, ) = recipientFeePool.getLpInfo(LP);
        vm.prank(LP);
        vm.expectRevert(bytes("Unsupported token behavior."));
        recipientFeePool.removeLiquidity(LP, uint128(shares[shares.length - 1]));

        RebaseSafetyToken rebasingLoan = new RebaseSafetyToken("Rebase", "REB");
        BasePool rebasePool = _pool(IERC20(address(rebasingLoan)), IERC20(address(coll)), IController(address(controller)), 0);
        _approveAndFund(rebasingLoan, LP, MIN_LIQUIDITY * 2, address(rebasePool));
        vm.prank(LP);
        rebasePool.addLiquidity(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);
        rebasingLoan.setRebaseEnabled(true);
        vm.warp(block.timestamp + 121);
        (, , , shares, ) = rebasePool.getLpInfo(LP);
        vm.prank(LP);
        vm.expectRevert(bytes("Unsupported token behavior."));
        rebasePool.removeLiquidity(LP, uint128(shares[shares.length - 1]));
    }

    function test_exactBorrowAndRepayDeltas_rejectUnsupportedTransfers() public {
        MockRewardController controller = new MockRewardController();
        ToggleFeeSafetyToken loan = new ToggleFeeSafetyToken("Loan", "LOAN");
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        BasePool pool = _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(controller)), 0);
        _approveAndFund(loan, LP, MIN_LIQUIDITY * 5, address(pool));
        vm.prank(LP);
        pool.addLiquidity(LP, MIN_LIQUIDITY * 3, block.timestamp, 0);
        _approveAndFund(collateral, BORROWER, 20_000, address(pool));

        loan.setFeeEnabled(true);
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        vm.expectRevert(bytes("Unsupported token behavior."));
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);

        loan.setFeeEnabled(false);
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (, , , , , , , , uint256 loanIdx) = pool.getPoolInfo();
        loanIdx -= 1;
        (uint128 repayment, , , , , ) = pool.loanIdxToLoanInfo(loanIdx);
        _approveAndFund(loan, BORROWER, repayment * 2, address(pool));
        loan.setFeeEnabled(true);
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        vm.expectRevert(bytes("Unsupported token behavior."));
        pool.repay(loanIdx, BORROWER);

        ToggleFeeZeroSafetyToken feeCollateral = new ToggleFeeZeroSafetyToken("Fee collateral", "FCOLL");
        SafetyToken plainLoan = new SafetyToken("Plain loan", "PLOAN");
        BasePool repayPool = _pool(IERC20(address(plainLoan)), IERC20(address(feeCollateral)), IController(address(controller)), 0);
        _approveAndFund(plainLoan, LP, MIN_LIQUIDITY * 3, address(repayPool));
        vm.prank(LP);
        repayPool.addLiquidity(LP, MIN_LIQUIDITY * 2, block.timestamp, 0);
        _approveAndFund(feeCollateral, BORROWER, 20_000, address(repayPool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        repayPool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
        (, , , , , , , , loanIdx) = repayPool.getPoolInfo();
        loanIdx -= 1;
        (repayment, , , , , ) = repayPool.loanIdxToLoanInfo(loanIdx);
        _approveAndFund(plainLoan, BORROWER, repayment * 2, address(repayPool));
        feeCollateral.setFeeEnabled(true);
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        vm.expectRevert(bytes("Unsupported token behavior."));
        repayPool.repay(loanIdx, BORROWER);

        ShortZeroSafetyToken shortCollateral = new ShortZeroSafetyToken("Short collateral", "SCOLL");
        SafetyToken shortLoan = new SafetyToken("Short loan", "SLOAN");
        BasePool borrowPool = _pool(IERC20(address(shortLoan)), IERC20(address(shortCollateral)), IController(address(controller)), 0);
        _approveAndFund(shortLoan, LP, MIN_LIQUIDITY * 3, address(borrowPool));
        vm.prank(LP);
        borrowPool.addLiquidity(LP, MIN_LIQUIDITY * 2, block.timestamp, 0);
        _approveAndFund(shortCollateral, BORROWER, 20_000, address(borrowPool));
        vm.warp(block.timestamp + 1);
        vm.prank(BORROWER);
        vm.expectRevert(bytes("Unsupported token behavior."));
        borrowPool.borrow(BORROWER, 10_000, 0, type(uint128).max, block.timestamp, 0);
    }

    function test_optionalRevenueFailure_clearsControllerAllowance() public {
        SafetyToken loan = new SafetyToken("Loan", "LOAN");
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        MockFakeController controller = new MockFakeController();
        BasePool pool = _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(controller)), 0);
        _approveAndFund(loan, LP, MIN_LIQUIDITY * 3, address(pool));

        vm.startPrank(LP);
        pool.addLiquidity(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);
        vm.warp(block.timestamp + 121);
        (, , , uint256[] memory shares, ) = pool.getLpInfo(LP);
        pool.removeLiquidity(LP, uint128(shares[shares.length - 1]));
        pool.addLiquidity(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);
        vm.stopPrank();

        assertEq(loan.allowance(address(pool), address(controller)), 0, "failed optional revenue must clear allowance");
    }

    function test_controllerExactDepositsAndOutboundDelta() public {
        ToggleFeeSafetyToken voteToken = new ToggleFeeSafetyToken("Vote", "VOTE");
        Controller controller = new Controller(
            IERC20(address(voteToken)), 5000, 5000, 5000, 5000, 100, 0, address(this)
        );
        _approveAndFund(voteToken, LP, 1_000, address(controller));

        voteToken.setFeeEnabled(true);
        vm.startPrank(LP);
        vm.expectRevert(bytes("Unsupported token behavior."));
        controller.depositVoteToken(100);
        vm.expectRevert(bytes("Unsupported token behavior."));
        controller.depositRewardSupply(100);
        vm.stopPrank();
        assertEq(controller.voteTokenTotalSupply(), 0);
        assertEq(controller.rewardSupply(), 0);

        voteToken.setFeeEnabled(false);
        vm.prank(LP);
        controller.depositVoteToken(100);
        voteToken.setFeeEnabled(true);
        vm.prank(LP);
        vm.expectRevert(bytes("Unsupported token behavior."));
        controller.withdrawVoteToken(100);
    }

    function test_msgValueRejectedAndGovernanceThresholdIncludesEquality() public {
        SafetyToken loan = new SafetyToken("Loan", "LOAN");
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        MockRewardController rewardController = new MockRewardController();
        BasePool pool = _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(rewardController)), 0);
        _approveAndFund(loan, LP, MIN_LIQUIDITY * 2, address(pool));
        vm.deal(LP, 1);
        vm.prank(LP);
        vm.expectRevert(bytes("Native value unsupported."));
        pool.addLiquidity{value: 1}(LP, MIN_LIQUIDITY + 1, block.timestamp, 0);

        SafetyToken voteToken = new SafetyToken("Vote", "VOTE");
        Controller controller = new Controller(
            IERC20(address(voteToken)), 5000, 5000, 5000, 5000, 100, 0, address(this)
        );
        _approveAndFund(voteToken, LP, 50, address(controller));
        address voterTwo = address(0x2222);
        _approveAndFund(voteToken, voterTwo, 50, address(controller));
        vm.prank(LP);
        controller.depositVoteToken(50);
        vm.prank(voterTwo);
        controller.depositVoteToken(50);
        PausableSafetyTarget target = new PausableSafetyTarget();
        controller.createProposal(target, IController.Action.PAUSE, block.timestamp + 100);
        vm.prank(LP);
        controller.vote(0);
        assertTrue(target.paused(), "a vote exactly at threshold must execute");
    }

    function test_governanceThresholdCeilDoesNotAuthorizeOneOfThree() public {
        SafetyToken voteToken = new SafetyToken("Vote", "VOTE");
        Controller controller = new Controller(
            IERC20(address(voteToken)),
            5000,
            5000,
            5000,
            5000,
            100,
            0,
            address(this)
        );
        address voterTwo = address(0x2222);
        address voterThree = address(0x3333);
        _approveAndFund(voteToken, LP, 1, address(controller));
        _approveAndFund(voteToken, voterTwo, 1, address(controller));
        _approveAndFund(voteToken, voterThree, 1, address(controller));
        vm.prank(LP);
        controller.depositVoteToken(1);
        vm.prank(voterTwo);
        controller.depositVoteToken(1);
        vm.prank(voterThree);
        controller.depositVoteToken(1);

        PausableSafetyTarget target = new PausableSafetyTarget();
        controller.createProposal(target, IController.Action.PAUSE, block.timestamp + 100);
        vm.prank(LP);
        controller.vote(0);
        assertFalse(target.paused(), "one of three votes must not pass a 50% threshold");
        vm.prank(voterTwo);
        controller.vote(0);
        assertTrue(target.paused(), "two of three votes must pass a 50% threshold");
    }

    function test_constructorRejectsBadCodeMetadataMinLoanAndTenor() public {
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        MockRewardController controller = new MockRewardController();
        SafetyToken loan = new SafetyToken("Loan", "LOAN");

        vm.expectRevert(bytes("Loan token must be a contract."));
        _pool(IERC20(address(0x1234)), IERC20(address(collateral)), IController(address(controller)), 0);

        MetadataSafetyToken loan6 = new MetadataSafetyToken(6);
        BasePool loan6Pool = _pool(
            IERC20(address(loan6)),
            IERC20(address(collateral)),
            IController(address(controller)),
            0
        );
        _approveAndFund(loan6, LP, MIN_LIQUIDITY * 3, address(loan6Pool));
        vm.prank(LP);
        loan6Pool.addLiquidity(LP, MIN_LIQUIDITY * 2, block.timestamp, 0);
        (uint128 loan6Amount, , , , ) = loan6Pool.loanTerms(10_000);
        assertGt(loan6Amount, 0, "six-decimal loan token must support loan terms");

        vm.expectRevert(bytes("Collateral decimals mismatch."));
        _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(controller)), 18);

        MetadataSafetyToken coll31 = new MetadataSafetyToken(31);
        vm.expectRevert(bytes("Invalid collateral decimals."));
        _pool(IERC20(address(loan)), IERC20(address(coll31)), IController(address(controller)), 31);

        vm.expectRevert(bytes("Min loan must not be 0."));
        _poolWith(IERC20(address(loan)), IERC20(address(collateral)), IController(address(controller)), 0, LOAN_TENOR, 0);

        vm.expectRevert(bytes("Min loan too large."));
        _poolWith(
            IERC20(address(loan)),
            IERC20(address(collateral)),
            IController(address(controller)),
            0,
            LOAN_TENOR,
            uint256(type(uint128).max) + 1
        );

        vm.expectRevert(bytes("Loan tenor too large."));
        _poolWith(
            IERC20(address(loan)),
            IERC20(address(collateral)),
            IController(address(controller)),
            0,
            uint256(type(uint32).max) + 1,
            MIN_LOAN
        );

        vm.expectRevert(bytes("Controller must be a contract."));
        _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(0x5678)), 0);

        // At the minimum valid loan, the low-liquidity rate peak must still
        // produce a repayment that fits LoanInfo.repayment (uint128).
        uint256[] memory excessiveRates = _rates();
        excessiveRates[0] =
            ((uint256(type(uint128).max) - MIN_LOAN + 1) * 1e18 - 1) /
                MIN_LOAN /
                BND1 +
            1;
        vm.expectRevert(bytes("Rate parameters too large."));
        new BasePool(
            _tokens(IERC20(address(loan)), IERC20(address(collateral))),
            0,
            LOAN_TENOR,
            MAX_LOAN_PER_COLL,
            excessiveRates,
            _bounds(),
            MIN_LOAN,
            CREATOR_FEE,
            MIN_LIQUIDITY,
            IController(address(controller)),
            REWARD_COEFFICIENT
        );
    }

    function test_borrowRejectsOnBehalfOfWithoutChangingPoolState() public {
        SafetyToken loan = new SafetyToken("Loan", "LOAN");
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        MockRewardController controller = new MockRewardController();
        BasePool pool = _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(controller)), 0);
        _approveAndFund(loan, LP, MIN_LIQUIDITY * 2 + 1, address(pool));
        vm.prank(LP);
        pool.addLiquidity(LP, MIN_LIQUIDITY * 2 + 1, block.timestamp, 0);
        _approveAndFund(collateral, BORROWER, 10_000, address(pool));

        vm.expectRevert(bytes("Borrower must be sender."));
        vm.prank(BORROWER);
        pool.borrow(address(0xCAFE), 1_000, 0, type(uint128).max, block.timestamp, 0);

        (, , , , , , , , uint256 nextLoanIdx) = pool.getPoolInfo();
        assertEq(nextLoanIdx, 1, "rejected delegated borrow must not record a loan");
        assertEq(collateral.balanceOf(BORROWER), 10_000, "rejected delegated borrow must not pull collateral");
    }

    function test_loanIndexCeilingRejectsNewBorrowBeforeRecordingState() public {
        SafetyToken loan = new SafetyToken("Loan", "LOAN");
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        MockRewardController controller = new MockRewardController();
        BasePool pool = _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(controller)), 0);
        _approveAndFund(loan, LP, MIN_LIQUIDITY * 3, address(pool));
        vm.prank(LP);
        pool.addLiquidity(LP, MIN_LIQUIDITY * 2 + 1, block.timestamp, 0);
        _approveAndFund(collateral, BORROWER, 10_000, address(pool));

        // `loanIdx` is a uint256 storage counter, but every recorded loan
        // feeds uint32-backed expiry/share cursors.
        vm.store(address(pool), bytes32(uint256(12)), bytes32(uint256(type(uint32).max)));
        vm.expectRevert(bytes("Loan index too large."));
        vm.prank(BORROWER);
        pool.borrow(BORROWER, 1_000, 0, type(uint128).max, block.timestamp, 0);
    }

    function test_constructorRejectsTenorPastDeploymentExpiryCeiling() public {
        SafetyToken loan = new SafetyToken("Loan", "LOAN");
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        MockRewardController controller = new MockRewardController();

        vm.warp(2_000_000_000);
        uint256 boundaryTenor = uint256(type(uint32).max) - block.timestamp;
        BasePool pool = _poolWith(
            IERC20(address(loan)),
            IERC20(address(collateral)),
            IController(address(controller)),
            0,
            boundaryTenor,
            MIN_LOAN
        );
        (, , , , uint256 actualTenor, , , , ) = pool.getPoolInfo();
        assertEq(actualTenor, boundaryTenor, "maximum deployment-safe tenor must be accepted");

        vm.expectRevert(bytes("Loan tenor too large."));
        _poolWith(
            IERC20(address(loan)),
            IERC20(address(collateral)),
            IController(address(controller)),
            0,
            boundaryTenor + 1,
            MIN_LOAN
        );
    }

    function test_extremeRateTermsFailBoundedlyWithoutArithmeticPanic() public {
        SafetyToken loan = new SafetyToken("Loan", "LOAN");
        ZeroDecimalSafetyToken collateral = new ZeroDecimalSafetyToken("Collateral", "COLL");
        MockRewardController controller = new MockRewardController();
        BasePool pool = _pool(IERC20(address(loan)), IERC20(address(collateral)), IController(address(controller)), 0);
        _approveAndFund(loan, LP, MIN_LIQUIDITY * 3, address(pool));
        vm.prank(LP);
        pool.addLiquidity(LP, MIN_LIQUIDITY * 2 + 1, block.timestamp, 0);

        // Force the low-liquidity rate path to exercise full-precision
        // multiplication. The resulting repayment does not fit LoanInfo's
        // uint128 field and must use the explicit bounded error.
        vm.store(address(pool), bytes32(uint256(13)), bytes32(type(uint256).max));
        vm.expectRevert(bytes("Repayment amount too large."));
        pool.loanTerms(10_000);
    }

    function test_controllerRejectsZeroVoteTokenAndVetoHolder() public {
        vm.expectRevert(bytes("Invalid vote token."));
        new Controller(
            IERC20(address(0)), 5000, 5000, 5000, 5000, 100, 0, address(this)
        );

        vm.expectRevert(bytes("Vote token must be a contract."));
        new Controller(
            IERC20(address(0x1234)), 5000, 5000, 5000, 5000, 100, 0, address(this)
        );

        SafetyToken voteToken = new SafetyToken("Vote", "VOTE");
        MetadataSafetyToken voteToken6 = new MetadataSafetyToken(6);
        vm.expectRevert(bytes("Vote token must use 18 decimals."));
        new Controller(
            IERC20(address(voteToken6)), 5000, 5000, 5000, 5000, 100, 0, address(this)
        );
        vm.expectRevert(bytes("Invalid veto holder."));
        new Controller(
            IERC20(address(voteToken)), 5000, 5000, 5000, 5000, 100, 0, address(0)
        );
    }
}
