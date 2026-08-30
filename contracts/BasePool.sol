// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import {IBasePool} from "./interfaces/IBasePool.sol";
import "./interfaces/IPausable.sol";
import "./interfaces/IController.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

interface IControllerWhitelist {
    function poolWhitelisted(address _pool) external view returns (bool);
}

contract BasePool is IBasePool, Pausable, ReentrancyGuard, IPausable {
    using SafeERC20 for IERC20;

    // Minimum period between adding liqudity and removing it, in seconds
    uint256 constant MIN_LPING_PERIOD = 120;

    // Minimum loan tenor, in seconds
    uint256 constant MIN_TENOR = 86400;
    // LoanInfo.expiry is uint32; larger tenors would truncate on borrow.
    uint256 constant MAX_TIMESTAMP = type(uint32).max;
    // Keep the exponent in loanTerms within the supported token-decimal range.
    uint256 constant MAX_TOKEN_DECIMALS = 30;
    uint256 constant BASE = 10 ** 18;
    // Bound claim work per transaction so every validation path is predictable.
    uint256 public constant MAX_CLAIM_BATCH = 50;

    // Maximum protocol revenue fee, denominated in BASE
    uint256 constant MAX_FEE = 300 * 10 ** 14; // 300bps

    // Minimum liquidity, denominated in loanCcy decimals
    uint256 public override minLiquidity;

    // Address of the controller contract
    IController public poolController;

    // Collateral token
    IERC20 collCcyToken;
    // Loan token
    IERC20 loanCcyToken;

    // Total LP shares. Denominated and discretized in 1/1000th of minLiquidity
    uint128 totalLpShares;

    // Loan duration, in seconds
    uint256 loanTenor;
    
    // Decimals of the collateral token
    uint256 public override collTokenDecimals;

    // Maximum loan per unit of collateral, denominated in loanCcy decimals
    uint256 maxLoanPerColl;

    // Protocol revenue fee, denominated in BASE
    uint256 creatorFee;

    // Total liquidity, denominated in loanCcy decimals
    uint256 totalLiquidity;

    // Current loan index
    uint256 loanIdx;

    // Interest rate parameters
    uint256 r1; // Denominated in BASE and w.r.t. tenor (i.e., not annualized)
    uint256 r2; // Denominated in BASE and w.r.t. tenor (i.e., not annualized)
    uint256 liquidityBnd1; // Denominated in loanCcy decimals
    uint256 liquidityBnd2; // Denominated in loanCcy decimals

    // Minimum loan, denominated in loanCcy decimals
    uint256 minLoan;

    // LP infos
    mapping(address => LpInfo) addrToLpInfo;

    // Used to prevent flash loans
    mapping(address => uint256) lastAddOfTxOrigin;

    // Loan infos
    mapping(uint256 => LoanInfo) public loanIdxToLoanInfo;

    // Borrower of a loan
    mapping(uint256 => address) public override loanIdxToBorrower;

    // Whether an address is approved to perform a certain action
    mapping(address => mapping(address => mapping(IBasePool.ApprovalTypes => bool)))
        public override isApproved;

    // Timestamp of the last reward of an address
    mapping(address => uint32) public lastRewardTimestamp;

    // Last tracked liquidity of an address
    mapping(address => uint128) public lastTrackedLiquidity;

    // Reward coefficient, denominated in BASE
    uint96 rewardCoefficient;

    // Number of LP shares that have already claimed each settled loan.
    // Kept separate from LoanInfo so its getter ABI remains unchanged.
    mapping(uint256 => uint128) public claimedLpShares;

    // Revenue held by the pool while a best-effort controller deposit is pending.
    mapping(IERC20 => uint256) public pendingRevenue;

    // Reward amounts requested while the controller was unavailable or
    // under-funded. This explicit debt can be retried without blocking exits.
    mapping(address => uint256) public pendingRewardDebt;

    /**
     * @notice Creates a new pool
     *
     * @dev Solidity has a stack limit which prevents having too many parameters.
     * As a workaround, we use two-element arrays when it's sufficiently intuitive
     *
     * @param _tokens [loanCcyToken, collCcyToken] Tokens used for the pool
     * @param _loanTenor Duration of a loan, in seconds
     * @param _maxLoanPerColl Maximum loan per unit of collateral, denominated in loanCcy decimals
     * @param _rs [r1, r2] Interest rate parameters, denominated in BASE and w.r.t. tenor (i.e., not annualized)
     * @param _liquidityBnds [liquidityBnd1, liquidityBnd2] Liqudity parameters, denominated in loanCcy decimals
     * @param _minLoan Minimum loan, denominated in loanCcy decimals
     * @param _creatorFee Protocol revenue fee, denominated in BASE
     * @param _minLiquidity Minimum liquidity, denominated in loanCcy decimals
     * @param _poolController Address of the controller contract
     * @param _rewardCoefficient Reward coefficient, denominated in BASE
    */
    constructor(
        IERC20[] memory _tokens,
        uint256 _collTokenDecimals,
        uint256 _loanTenor,
        uint256 _maxLoanPerColl,
        uint256[] memory _rs,
        uint256[] memory _liquidityBnds,
        uint256 _minLoan,
        uint256 _creatorFee,
        uint256 _minLiquidity,
        IController _poolController,
        uint96 _rewardCoefficient
    ) {
        require(_tokens.length == 2, "Tokens length must be 2.");
        require(_rs.length == 2, "Rs length must be 2.");
        require(_liquidityBnds.length == 2, "Liquidity bounds length must be 2.");

        require(_tokens[0] != _tokens[1], "Loan and collateral must not be the same.");
        if (address(_tokens[0]) == address(0) || address(_tokens[1]) == address(0))
            revert("Loan and collateral tokens must not be 0.");
        require(address(_tokens[0]).code.length > 0, "Loan token must be a contract.");
        require(address(_tokens[1]).code.length > 0, "Collateral token must be a contract.");
        require(_readTokenDecimals(_tokens[0]) <= MAX_TOKEN_DECIMALS, "Invalid loan decimals.");
        require(_readTokenDecimals(_tokens[1]) == _collTokenDecimals, "Collateral decimals mismatch.");
        require(address(_poolController) != address(0), "Invalid Controller.");
        require(address(_poolController).code.length > 0, "Controller must be a contract.");
        require(_poolController.supportsInterface(type(IController).interfaceId), "Invalid Controller.");
        require(_collTokenDecimals <= MAX_TOKEN_DECIMALS, "Invalid collateral decimals.");
        require(_loanTenor >= MIN_TENOR, "Loan tenor must be at least MIN_TENOR.");
        require(_loanTenor <= MAX_TIMESTAMP, "Loan tenor too large.");
        require(_maxLoanPerColl > 0, "Max loan must not be 0.");
        require(
            _maxLoanPerColl <= type(uint256).max / (2 * uint256(type(uint128).max)),
            "Max loan ratio too large."
        );
        if (_rs[0] <= _rs[1] || _rs[1] == 0) revert("Invalid rate parameters.");
        if (_liquidityBnds[1] <= _liquidityBnds[0] || _liquidityBnds[0] == 0)
            revert("Invalid liquidity bounds");
        // ensure LP shares can be minted based on 1/1000th of minLp discretization
        require(_minLiquidity >= 1000, "Min liquidity must be at least 1000.");
        require(_minLiquidity < type(uint128).max, "Min liquidity too large.");
        require(
            _minLiquidity <= type(uint256).max / (2 * (10 ** _collTokenDecimals)),
            "Min liquidity too large."
        );
        require(_minLoan > 0, "Min loan must not be 0.");
        require(_minLoan <= type(uint256).max / BASE, "Min loan too large.");
        require(_minLoan <= type(uint128).max, "Min loan too large.");
        // The smallest valid loan is _minLoan. Bound the maximum reciprocal
        // rate so its repayment still fits LoanInfo.repayment (uint128), even
        // at the low-liquidity peak r1 * liquidityBnd1. The `+1` and `-1`
        // account for Math.mulDiv's floor and make this the exact rate ceiling
        // for the minimum quote: floor(_minLoan * rate / BASE) <= U - _minLoan.
        uint256 maxRateForMinLoan =
            ((uint256(type(uint128).max) - _minLoan + 1) * BASE - 1) /
            _minLoan;
        require(
            _rs[0] <= maxRateForMinLoan / _liquidityBnds[0],
            "Rate parameters too large."
        );
        require(_creatorFee <= MAX_FEE, "Creator fee too high.");
        loanCcyToken = _tokens[0];
        collCcyToken = _tokens[1];
        loanTenor = _loanTenor;
        maxLoanPerColl = _maxLoanPerColl;
        r1 = _rs[0];
        r2 = _rs[1];
        liquidityBnd1 = _liquidityBnds[0];
        liquidityBnd2 = _liquidityBnds[1];
        minLoan = _minLoan;
        loanIdx = 1;
        collTokenDecimals = _collTokenDecimals;
        creatorFee = _creatorFee;
        minLiquidity = _minLiquidity;
        poolController = _poolController;
        rewardCoefficient = _rewardCoefficient;

        emit NewSubPool(
            loanCcyToken,
            collCcyToken,
            _loanTenor,
            _maxLoanPerColl,
            r1,
            r2,
            liquidityBnd1,
            liquidityBnd2,
            _minLoan,
            _creatorFee,
            address(poolController),
            rewardCoefficient
        );
    }

    /**
     * @notice Adds liquidity to the pool
     *
     * @param _onBehalfOf Address to add liquidity on behalf of
     * @param _deadline Deadline for the transaction
     * @param _referralCode Referral code. Optional
     */
    function addLiquidity(
        address _onBehalfOf,
        uint128 _sendAmount,
        uint256 _deadline,
        uint256 _referralCode
    ) external override payable nonReentrant whenNotPaused {
        require(msg.value == 0, "Native value unsupported.");
        _requirePoolWhitelisted();
        // verify LP info and eligibility
        checkTimestamp(_deadline);
        checkSenderApproval(_onBehalfOf, IBasePool.ApprovalTypes.ADD_LIQUIDITY);

        _transferFromExact(loanCcyToken, msg.sender, _sendAmount);

        (
            uint256 dust,
            uint256 newLpShares,
            uint32 earliestRemove
        ) = _addLiquidity(_onBehalfOf, _sendAmount);


        _updateRewardAndSend(
            _onBehalfOf,
            uint256(lastTrackedLiquidity[_onBehalfOf]) + uint256(_sendAmount)
        );

        // Deposit rounding dust as protocol revenue if any.
        if (dust > 0) {
            _depositRevenue(loanCcyToken, dust);
        }
        // spawn event
        emit AddLiquidity(
            _onBehalfOf,
            _sendAmount,
            newLpShares,
            totalLiquidity,
            totalLpShares,
            earliestRemove,
            loanIdx,
            _referralCode
        );
    }

    /**
     * @notice Removes liquidity from the pool. The removed amount is
     * propositional to the number of shares
     * 
     * @param _onBehalfOf Address to remove liquidity on behalf of
     * @param numShares Number of shares to remove
     */
    function removeLiquidity(
        address _onBehalfOf,
        uint128 numShares
    ) external override nonReentrant {
        // NOTE: no clear of lastAddOfTxOrigin here. The same-block flash-loan guard
        // (set in _addLiquidity, checked in borrow) stores block.timestamp and is
        // compared against the *current* block.timestamp, so it self-expires the
        // moment the block advances — no explicit clear is needed. Do NOT re-key a
        // clear to tx.origin here: that would let an attacker add -> removeLiquidity
        // -> borrow within a single block and bypass the guard (strictly worse).
        // verify LP info and eligibility
        checkSenderApproval(
            _onBehalfOf,
            IBasePool.ApprovalTypes.REMOVE_LIQUIDITY
        );

        LpInfo storage lpInfo = addrToLpInfo[_onBehalfOf];
        uint256 shareLength = lpInfo.sharesOverTime.length;
        if (
            shareLength == 0 ||
            numShares == 0 ||
            lpInfo.sharesOverTime[shareLength - 1] < numShares
        ) revert("Invalid removal operation.");
        if (block.timestamp < lpInfo.earliestRemove)
            revert("Too early to remove.");
        uint256 _totalLiquidity = totalLiquidity;
        uint128 _totalLpShares = totalLpShares;
        // update state of pool
        uint256 liquidityRemoved = Math.mulDiv(
            numShares,
            _totalLiquidity - minLiquidity,
            _totalLpShares
        );
        require(liquidityRemoved > 0, "No removable liquidity.");
        totalLpShares -= numShares;
        totalLiquidity = _totalLiquidity - liquidityRemoved;

        // update LP arrays and check for auto increment
        updateLpArrays(lpInfo, numShares, false);

        _updateRewardAndSend(_onBehalfOf, _satSub(lastTrackedLiquidity[_onBehalfOf], liquidityRemoved));
        if (lpInfo.sharesOverTime[lpInfo.sharesOverTime.length - 1] == 0) {
            // No current shares means no liquidity is eligible for the next reward interval.
            lastTrackedLiquidity[_onBehalfOf] = 0;
        }

        // Avoid invoking non-standard token callbacks for a zero-value exit.
        if (liquidityRemoved > 0) {
            _transferExact(loanCcyToken, msg.sender, liquidityRemoved);
        }
        // spawn event
        emit RemoveLiquidity(
            _onBehalfOf,
            liquidityRemoved,
            numShares,
            totalLiquidity,
            _totalLpShares - numShares,
            loanIdx
        );
    }

    /**
     * @notice Borrows funds from the pool
     * 
     * @dev Borrowing is self-only: the caller provides the collateral, receives
     * the loan proceeds, and becomes the recorded borrower.
     *
     * @dev When the contract is paused, this function cannot be called
     *
     * @param _onBehalfOf Must equal msg.sender and becomes the borrower
     * @param _sendAmount Amount of collateral to send
     * @param _minLoanLimit Minimum loan amount
     * @param _maxRepayLimit Maximum repayment amount
     * @param _deadline Deadline for the transaction
     * @param _referralCode Referral code. Optional
     */
    function borrow(
        address _onBehalfOf,
        uint128 _sendAmount,
        uint128 _minLoanLimit,
        uint128 _maxRepayLimit,
        uint256 _deadline,
        uint256 _referralCode
    ) external payable override nonReentrant whenNotPaused {
        require(msg.value == 0, "Native value unsupported.");
        if (_onBehalfOf == address(0)) revert("Invalid operation.");
        require(_onBehalfOf == msg.sender, "Borrower must be sender.");
        _requirePoolWhitelisted();
        uint256 _timestamp = checkTimestamp(_deadline);
        // LoanInfo expiry and LP cursors are uint32-backed. Do not record a
        // loan whose index would make the next cursor unrepresentable.
        require(loanIdx < type(uint32).max, "Loan index too large.");
        // check if atomic add and borrow as well as sanity check of onBehalf address
        if (lastAddOfTxOrigin[tx.origin] == _timestamp)
            revert("Invalid operation.");
        // get borrow terms and do checks
        (
            uint128 loanAmount,
            uint128 repaymentAmount,
            uint128 pledgeAmount,
            uint32 expiry,
            uint256 _creatorFee,
            uint256 _totalLiquidity
        ) = _borrow(
                _sendAmount,
                _minLoanLimit,
                _maxRepayLimit,
                _timestamp
            );
        {
            // update pool state
            totalLiquidity = _totalLiquidity - loanAmount;

            uint256 _loanIdx = loanIdx;
            uint128 _totalLpShares = totalLpShares;

            // update loan info
            loanIdxToBorrower[_loanIdx] = _onBehalfOf;
            LoanInfo memory loanInfo;
            loanInfo.repayment = repaymentAmount;
            loanInfo.totalLpShares = _totalLpShares;
            loanInfo.expiry = expiry;
            loanInfo.collateral = pledgeAmount;
            loanInfo.loanAmount = loanAmount;
            loanIdxToLoanInfo[_loanIdx] = loanInfo;

            // update loan idx counter
            loanIdx = _loanIdx + 1;
        }
        {
            // Retrieve collateral before recording protocol revenue.
            _transferFromExact(collCcyToken, msg.sender, _sendAmount);

            // Deposit protocol revenue in collateral currency.
            _depositRevenue(collCcyToken, _creatorFee);

            // transfer loanAmount in loan ccy
            _transferExact(loanCcyToken, msg.sender, loanAmount);
        }
        // spawn event
        emit Borrow(
            _onBehalfOf,
            loanIdx - 1,
            pledgeAmount,
            loanAmount,
            repaymentAmount,
            totalLpShares,
            expiry,
            _referralCode
        );
    }


    /**
     * @notice Repays a loan
     *
     * @dev Only senders approved by the borrower can repay the loan
     *
     * @param _loanIdx Index of the loan to repay
     * @param _recipient Address to receive the funds
     */
    function repay(
        uint256 _loanIdx,
        address _recipient
    ) external payable override nonReentrant {
        require(msg.value == 0, "Native value unsupported.");
        // verify loan info and eligibility
        if (_loanIdx == 0 || _loanIdx >= loanIdx) revert("Invalid loan index.");
        address _loanOwner = loanIdxToBorrower[_loanIdx];

        if (msg.sender != _loanOwner && _recipient != _loanOwner)
            revert("Invalid recipient.");
        checkSenderApproval(_loanOwner, IBasePool.ApprovalTypes.REPAY);

        LoanInfo storage loanInfo = loanIdxToLoanInfo[_loanIdx];
        uint256 timestamp = block.timestamp;
        if (timestamp > loanInfo.expiry) revert("Cannot repay after expiry.");
        if (loanInfo.repaid) revert("Already repaid.");
        if (timestamp == loanInfo.expiry - loanTenor)
            revert("Cannot repay in the same block.");
        // update loan info
        loanInfo.repaid = true;

        _transferFromExact(loanCcyToken, msg.sender, loanInfo.repayment);
        // transfer collateral to _recipient (allows for possible
        // transfer directly to someone other than payer/sender)
        _transferExact(collCcyToken, _recipient, loanInfo.collateral);
        // spawn event
        emit Repay(_loanOwner, _loanIdx, loanInfo.repayment);
    }

    /**
     * @notice Claims the rewards for a given loan
     *
     * @dev Only senders approved by the LP can claim the on the LP's
     * behalf
     *
     * @param _onBehalfOf Address to claim on behalf of
     * @param _loanIdxs Indices of the loans to claim for
     */
    function claim(
        address _onBehalfOf,
        uint256[] calldata _loanIdxs,
        bool _isReinvested,
        uint256 _deadline
    ) external override nonReentrant {
        // check if reinvested is chosen that deadline is valid and sender can add liquidity on behalf of
        if (_isReinvested) {
            claimReinvestmentCheck(_deadline, _onBehalfOf);
        }
        checkSenderApproval(_onBehalfOf, IBasePool.ApprovalTypes.CLAIM);
        (ClaimInfo memory claimInfo, uint256 reinvestedAmount) = _prepareClaim(
            _onBehalfOf,
            _loanIdxs,
            _isReinvested
        );

        (uint128 lastLiquidity, uint32 timeSinceLastReward) = _updateReward(_onBehalfOf, _satSub(lastTrackedLiquidity[_onBehalfOf], claimInfo.loanAmount));

        if (reinvestedAmount > 0) {
            // Note that 0 time has elapsed since the previous update, so no funds should be awarded
            _updateReward(
                _onBehalfOf,
                uint256(lastTrackedLiquidity[_onBehalfOf]) + reinvestedAmount
            );
        }

        _sendReward(_onBehalfOf, lastLiquidity, timeSinceLastReward);

        claimTransferAndReinvestment(
            _onBehalfOf,
            claimInfo.repayments,
            claimInfo.collateral,
            _isReinvested,
            reinvestedAmount
        );

        // spawn event
        emit Claim(_onBehalfOf, _loanIdxs, claimInfo.repayments, claimInfo.collateral);
    }

    function _prepareClaim(
        address _onBehalfOf,
        uint256[] calldata _loanIdxs,
        bool _isReinvested
    ) internal returns (ClaimInfo memory claimInfo, uint256 reinvestedAmount) {
        LpInfo storage lpInfo = addrToLpInfo[_onBehalfOf];

        // Validate the complete batch before touching claim state. In particular,
        // a claim can never skip an unsettled loan or silently advance the cursor.
        if (
            _loanIdxs.length == 0 ||
            _loanIdxs.length > MAX_CLAIM_BATCH ||
            lpInfo.sharesOverTime.length == 0
        ) revert("Invalid claim batch.");

        _normalizeZeroShareIntervals(lpInfo);
        uint256 startIndex = _loanIdxs[0];
        uint256 endIndex = _loanIdxs[_loanIdxs.length - 1];
        if (
            startIndex == 0 ||
            endIndex >= loanIdx ||
            startIndex != lpInfo.fromLoanIdx
        ) revert("Invalid claim range.");

        for (uint256 i = 1; i < _loanIdxs.length; ) {
            if (
                _loanIdxs[i - 1] == type(uint256).max ||
                _loanIdxs[i] != _loanIdxs[i - 1] + 1
            )
                revert("Non-consecutive loan indices.");
            unchecked {
                i++;
            }
        }

        // Aggregate each loan using the LP shares applicable at that exact index.
        claimInfo = _collectClaims(_loanIdxs, lpInfo);
        reinvestedAmount = _isReinvested
            ? _reinvestableAmount(claimInfo.repayments)
            : 0;

        // The collector advances the cursor through every consecutive index and
        // then skips any zero-share intervals before the next claim.
        _advanceSharePointer(lpInfo, endIndex);
    }

    /**
     * @notice Sets the approvals for a given address
     *
     * @dev The approvals are packed into a single uint256, with the
     * least significant 5 bits representing the approvals for the
     * following ApprovalTypes (0 = least significant bit):
     * 0: REPAY
     * 1: ADD_LIQUIDITY
     * 2: REMOVE_LIQUIDITY
     * 3: CLAIM
     * 4: FORCE_REWARD_UPDATE
     * For example, 10100 would set the approvals for FORCE_REWARD_UPDATE and REMOVE_LIQUIDITY.
     * 
     * @param _approvee Address to set approvals for
     * @param _packedApprovals Packed approvals
     */
    function setApprovals(
        address _approvee,
        uint256 _packedApprovals
    ) external override {
        if (msg.sender == _approvee || _approvee == address(0))
            revert("Invalid approval address.");
        _packedApprovals &= 0x1f; // 0x1f is equivalent to 11111 in binary
        for (uint256 index = 0; index < 5; ) {
            bool approvalFlag = ((_packedApprovals >> index) & uint256(1)) == 1;
            if (
                isApproved[msg.sender][_approvee][
                    IBasePool.ApprovalTypes(index)
                ] != approvalFlag
            ) {
                isApproved[msg.sender][_approvee][
                    IBasePool.ApprovalTypes(index)
                ] = approvalFlag;
                _packedApprovals |= uint256(1) << 5;
            }
            unchecked {
                index++;
            }
        }
        if (((_packedApprovals >> 5) & uint256(1)) == 1) {
            emit ApprovalUpdate(msg.sender, _approvee, _packedApprovals & 0x1f);
        }
    }

    /**
     * @notice Returns the LP info for a given address
     *
     * @param _lpAddr Address to get LP info for
     *
     * @return fromLoanIdx Internal tracker for the earliest loan index
     * @return earliestRemove Earliest time the LP can remove liquidity
     * @return currSharePtr Current share pointer
     * @return sharesOverTime Array of shares over time
     * @return loanIdxsWhereSharesChanged Array of loan indices where shares changed
     */
    function getLpInfo(
        address _lpAddr
    )
        external
        view
        override
        returns (
            uint32 fromLoanIdx,
            uint32 earliestRemove,
            uint32 currSharePtr,
            uint256[] memory sharesOverTime,
            uint256[] memory loanIdxsWhereSharesChanged
        )
    {
        LpInfo memory lpInfo = addrToLpInfo[_lpAddr];
        fromLoanIdx = lpInfo.fromLoanIdx;
        earliestRemove = lpInfo.earliestRemove;
        currSharePtr = lpInfo.currSharePtr;
        sharesOverTime = lpInfo.sharesOverTime;
        loanIdxsWhereSharesChanged = lpInfo.loanIdxsWhereSharesChanged;
    }

    /**
     * @notice Returns the current LP shares without copying share history
     * @param _lpAddr Address to get current shares for
     * @return currentShares The LP's current share balance
     */
    function getCurrentLpShares(address _lpAddr)
        external
        view
        override
        returns (uint256 currentShares)
    {
        LpInfo storage lpInfo = addrToLpInfo[_lpAddr];
        uint256 sharesLength = lpInfo.sharesOverTime.length;
        if (sharesLength > 0) {
            currentShares = lpInfo.sharesOverTime[sharesLength - 1];
        }
    }

    /**
     * @notice Returns the parameters used in the interest rate calculation
     *
     * @dev Refer to the whitepaper for an in-depth explanation
     * of the interest rate calculation
     *
     * @return _liquidityBnd1 First liquidity bound, denominated in loanCcy decimals
     * @return _liquidityBnd2 Second liquidity bound, denominated in loanCcy decimals
     * @return _r1 First interest rate, denominated in BASE
     * @return _r2 Second interest rate, denominated in BASE
     */
    function getRateParams()
        external
        view
        override
        returns (
            uint256 _liquidityBnd1,
            uint256 _liquidityBnd2,
            uint256 _r1,
            uint256 _r2
        )
    {
        _liquidityBnd1 = liquidityBnd1;
        _liquidityBnd2 = liquidityBnd2;
        _r1 = r1;
        _r2 = r2;
    }

    /**
     * @notice Returns the pool info
     * 
     * @return _loanCcyToken Loan currency token
     * @return _collCcyToken Collateral currency token
     * @return _maxLoanPerColl Maximum loan per collateral
     * @return _minLoan Minimum loan
     * @return _loanTenor Loan tenor (in seconds)
     * @return _totalLiquidity Total liquidity
     * @return _totalLpShares Total LP shares
     * @return _rewardCoefficient : Reward coefficient
     * @return _loanIdx Loan index
     */
    function getPoolInfo()
        external
        view
        override
        returns (
            IERC20 _loanCcyToken,
            IERC20 _collCcyToken,
            uint256 _maxLoanPerColl,
            uint256 _minLoan,
            uint256 _loanTenor,
            uint256 _totalLiquidity,
            uint256 _totalLpShares,
            uint96 _rewardCoefficient,
            uint256 _loanIdx
        )
    {
        _loanCcyToken = loanCcyToken;
        _collCcyToken = collCcyToken;
        _maxLoanPerColl = maxLoanPerColl;
        _minLoan = minLoan;
        _loanTenor = loanTenor;
        _totalLiquidity = totalLiquidity;
        _totalLpShares = totalLpShares;
        _rewardCoefficient = rewardCoefficient;
        _loanIdx = loanIdx;
    }

    /**
     * @notice Returns the terms for a hypothetical loan
     *
     * @dev Refer to the whitepaper for an in-depth explanation
     * of the interest rate calculation
     *
     * @param _inAmountAfterFees Amount of deposited collCcyToken, after transfer fees
     *
     * @return loanAmount Amount of loanCcyToken to borrow
     * @return repaymentAmount Amount of loanCcyToken to repay
     * @return pledgeAmount Amount of collCcyToken to pledge
     * @return _creatorFee Protocol revenue fee
     * @return _totalLiquidity Total liquidity
     */
    function loanTerms(
        uint128 _inAmountAfterFees
    )
        public
        view
        override
        returns (
            uint128 loanAmount,
            uint128 repaymentAmount,
            uint128 pledgeAmount,
            uint256 _creatorFee,
            uint256 _totalLiquidity
        )
    {
        // compute terms (as uint256)
        _creatorFee = Math.mulDiv(_inAmountAfterFees, creatorFee, BASE);
        uint256 pledge = _inAmountAfterFees - _creatorFee;
        _totalLiquidity = totalLiquidity;
        if (_totalLiquidity <= minLiquidity) revert("Insufficient liquidity.");
        uint256 availableLiquidity = _totalLiquidity - minLiquidity;
        uint256 collateralValue = pledge * maxLoanPerColl;
        uint256 collateralValueAtLiquidity = availableLiquidity * 10 ** collTokenDecimals;
        uint256 loan = Math.mulDiv(
            collateralValue,
            availableLiquidity,
            collateralValue + collateralValueAtLiquidity
        );
        if (loan < minLoan) revert("Loan too small.");
        uint256 postLiquidity = _totalLiquidity - loan;
        require(postLiquidity >= minLiquidity, "Insufficient post-borrow liquidity.");
        // we use the average rate to calculate the repayment amount
        uint256 avgRate = Math.average(
            getRate(_totalLiquidity - minLiquidity),
            getRate(postLiquidity - minLiquidity)
        );
        // if pre- and post-borrow liquidity are within target liquidity range
        // then the repayment amount exactly matches the amount of integrating the
        // loan size over the infinitesimal rate; else the repayment amount is
        // larger than the amount of integrating loan size over rate;
        uint256 interest = _mulDivOrMax(loan, avgRate, BASE);
        require(interest <= type(uint256).max - loan, "Repayment too large.");
        uint256 repayment = loan + interest;
        // return terms (as uint128)
        require(loan <= type(uint128).max, "Loan amount too large.");
        loanAmount = uint128(loan);
        require(repayment <= type(uint128).max, "Repayment amount too large.");
        repaymentAmount = uint128(repayment);
        require(pledge <= type(uint128).max, "Pledge amount too large.");
        pledgeAmount = uint128(pledge);
        if (repaymentAmount <= loanAmount) revert("Erroneous loan terms.");
    }

    /**
     * @notice Advances a position cursor over zero-share intervals.
     * @dev A zero-share interval is not claimable, but it must not strand a
     *      later position behind an old cursor. The first non-zero interval
     *      (or the current global loan index when none remains) is the only
     *      effective fromLoanIdx exposed to the next claim.
     */
    function _normalizeZeroShareIntervals(LpInfo storage _lpInfo) internal {
        uint256 sharesLength = _lpInfo.sharesOverTime.length;
        require(sharesLength > 0, "Nothing to claim.");

        uint256 sharePtr = _lpInfo.currSharePtr;
        require(sharePtr < sharesLength, "Invalid share pointer.");
        uint256 effectiveFrom = _lpInfo.fromLoanIdx;

        while (sharePtr < sharesLength && _lpInfo.sharesOverTime[sharePtr] == 0) {
            if (sharePtr >= _lpInfo.loanIdxsWhereSharesChanged.length) {
                effectiveFrom = loanIdx;
                break;
            }
            effectiveFrom = _lpInfo.loanIdxsWhereSharesChanged[sharePtr];
            unchecked {
                sharePtr++;
            }
        }

        require(
            sharePtr <= type(uint32).max && effectiveFrom <= type(uint32).max,
            "LP history exceeds uint32."
        );
        _lpInfo.currSharePtr = uint32(sharePtr);
        _lpInfo.fromLoanIdx = uint32(effectiveFrom);
    }

    /** @notice Advances the cursor after a consecutive claim batch. */
    function _advanceSharePointer(LpInfo storage _lpInfo, uint256 _lastIndex) internal {
        require(_lastIndex < type(uint32).max, "Loan index too large.");
        uint256 sharePtr = _lpInfo.currSharePtr;
        uint256 sharesLength = _lpInfo.sharesOverTime.length;
        uint256 changesLength = _lpInfo.loanIdxsWhereSharesChanged.length;

        while (sharePtr < changesLength && _lastIndex + 1 >= _lpInfo.loanIdxsWhereSharesChanged[sharePtr]) {
            unchecked {
                sharePtr++;
            }
        }

        require(sharePtr <= type(uint32).max, "LP history exceeds uint32.");
        _lpInfo.currSharePtr = uint32(sharePtr);
        _lpInfo.fromLoanIdx = uint32(_lastIndex + 1);
        _normalizeZeroShareIntervals(_lpInfo);
        require(_lpInfo.currSharePtr < sharesLength, "Invalid share pointer.");
    }

    /**
     * @notice Computes a pro-rata amount from the cumulative claimed share
     *         count. The final claim receives the exact remaining residual.
     */
    function _cumulativeClaimAmount(
        uint128 _amount,
        uint128 _oldShares,
        uint128 _newShares,
        uint128 _totalShares
    ) internal pure returns (uint256 amount) {
        require(_totalShares > 0 && _oldShares <= _totalShares && _newShares <= _totalShares, "Invalid claim shares.");
        require(_newShares >= _oldShares, "Claim shares decreased.");
        if (_newShares == _totalShares) {
            return uint256(_amount) - Math.mulDiv(_amount, _oldShares, _totalShares);
        }
        amount = Math.mulDiv(_amount, _newShares, _totalShares) -
            Math.mulDiv(_amount, _oldShares, _totalShares);
    }

    /**
     * @notice Collects claims while accounting for each loan's share history.
     * @dev State updates are intentionally made here, rather than in a view
     *      pre-calculation, so cumulative floors are shared by all LPs.
     */
    function _collectClaims(
        uint256[] calldata _loanIdxs,
        LpInfo storage _lpInfo
    ) internal returns (ClaimInfo memory claimInfo) {
        uint256 sharePtr = _lpInfo.currSharePtr;
        uint256 changesLength = _lpInfo.loanIdxsWhereSharesChanged.length;
        uint256 sharesLength = _lpInfo.sharesOverTime.length;

        for (uint256 i = 0; i < _loanIdxs.length; ) {
            uint256 index = _loanIdxs[i];
            while (sharePtr < changesLength && index >= _lpInfo.loanIdxsWhereSharesChanged[sharePtr]) {
                unchecked {
                    sharePtr++;
                }
            }
            require(sharePtr < sharesLength, "Invalid share pointer.");

            LoanInfo memory loanInfo = loanIdxToLoanInfo[index];
            uint128 oldClaimedShares = claimedLpShares[index];
            uint256 applicableShares = _lpInfo.sharesOverTime[sharePtr];
            require(applicableShares <= type(uint128).max, "Invalid claim shares.");
            require(
                uint256(oldClaimedShares) + applicableShares <= loanInfo.totalLpShares,
                "Claimed shares exceed total."
            );
            uint128 newClaimedShares = oldClaimedShares + uint128(applicableShares);

            if (loanInfo.repaid) {
                claimInfo.repayments += _cumulativeClaimAmount(
                    loanInfo.repayment,
                    oldClaimedShares,
                    newClaimedShares,
                    loanInfo.totalLpShares
                );
            } else if (loanInfo.expiry < block.timestamp) {
                claimInfo.collateral += _cumulativeClaimAmount(
                    loanInfo.collateral,
                    oldClaimedShares,
                    newClaimedShares,
                    loanInfo.totalLpShares
                );
            } else {
                revert("Cannot claim with unsettled loan.");
            }

            claimInfo.loanAmount += _cumulativeClaimAmount(
                loanInfo.loanAmount,
                oldClaimedShares,
                newClaimedShares,
                loanInfo.totalLpShares
            );
            claimedLpShares[index] = newClaimedShares;

            unchecked {
                i++;
            }
        }

        require(sharePtr <= type(uint32).max, "LP history exceeds uint32.");
        _lpInfo.currSharePtr = uint32(sharePtr);
    }

    /**
     * @notice Function which transfers collateral and repayments of claims and reinvests
     *
     * @dev This function will reinvest the loan currency only (and only of course if _isReinvested is true)
     *
     * @param _onBehalfOf LP address which is owner or has approved sender to claim on their behalf (and possibly reinvest)
    * @param _repayments Total repayments (loan currency) after all claims processed
    * @param _collateral Total collateral (collateral currency) after all claims processed
    * @param _isReinvested Flag for if LP wants claimed loanCcy to be re-invested
     * @param _reinvestedAmount Portion of repayments that can mint LP shares
     */
    function claimTransferAndReinvestment(
        address _onBehalfOf,
        uint256 _repayments,
        uint256 _collateral,
        bool _isReinvested,
        uint256 _reinvestedAmount
    ) internal {
        if (_repayments > 0) {
            if (_isReinvested && _reinvestedAmount > 0) {
                // allows reinvestment and transfer of any dust from claim functions
                (
                    uint256 dust,
                    uint256 newLpShares,
                    uint32 earliestRemove
                ) = _addLiquidity(_onBehalfOf, _reinvestedAmount);
                if (dust > 0) {
                    _depositRevenue(loanCcyToken, dust);
                }
                // spawn event
                emit Reinvest(
                    _onBehalfOf,
                    _reinvestedAmount,
                    newLpShares,
                    earliestRemove,
                    loanIdx
                );
            } else {
                // A repayment too small to mint one share is still claimable;
                // pay it out rather than reverting or crediting the tracker.
                _transferExact(loanCcyToken, msg.sender, _repayments);
            }
        }
        // transfer collateral
        if (_collateral > 0) {
            _transferExact(collCcyToken, msg.sender, _collateral);
        }
    }

    /**
     * @notice Helper function when adding liquidity
     *
     * @dev This function is called by addLiquidity, but also
     * by claimants who would like to reinvest their loanCcy
     * portion of the claim
     *
     * @param _onBehalfOf Recipient of the LP shares
     * @param _inAmountAfterFees Net amount of what was sent by LP minus fees
     *
     * @return dust If no LP shares, dust is any remaining excess liquidity (i.e. minLiquidity and rounding)
     * @return newLpShares Amount of new LP shares to be credited to LP.
     * @return earliestRemove Earliest timestamp from which LP is allowed to remove liquidity
     */
    function _addLiquidity(
        address _onBehalfOf,
        uint256 _inAmountAfterFees
    )
        internal
        returns (uint256 dust, uint256 newLpShares, uint32 earliestRemove)
    {
        uint256 _totalLiquidity = totalLiquidity;
        if (_inAmountAfterFees < minLiquidity / 1000) revert("Invalid add amount.");
        // retrieve lpInfo of sender
        LpInfo storage lpInfo = addrToLpInfo[_onBehalfOf];

        // calculate new lp shares
        if (totalLpShares == 0) {
            require(_inAmountAfterFees > minLiquidity, "Initial liquidity must exceed minimum.");
            dust = _totalLiquidity;
            _totalLiquidity = 0;
            newLpShares = Math.mulDiv(_inAmountAfterFees, 1000, minLiquidity);
        } else {
            assert(_totalLiquidity > 0);
            newLpShares = Math.mulDiv(_inAmountAfterFees, totalLpShares, _totalLiquidity);
        }
        if (newLpShares == 0 || uint128(newLpShares) != newLpShares)
            revert("Invalid add amount.");
        require(
            newLpShares <= type(uint128).max - totalLpShares,
            "LP shares too large."
        );
        totalLpShares += uint128(newLpShares);

        require(totalLpShares < minLoan * BASE, "Cannot add liquidity.");

        // loanTerms multiplies available liquidity by 10**collTokenDecimals.
        // Keep every funded pool inside that arithmetic domain instead of
        // allowing a later borrow to become permanently unusable.
        uint256 maxTermLiquidity = type(uint256).max / (2 * (10 ** collTokenDecimals));
        require(
            _totalLiquidity <= maxTermLiquidity &&
                _inAmountAfterFees <= maxTermLiquidity - _totalLiquidity,
            "Liquidity too large."
        );
        totalLiquidity = _totalLiquidity + _inAmountAfterFees;
        // update LP info
        bool isFirstAddLiquidity = lpInfo.fromLoanIdx == 0;
        if (isFirstAddLiquidity) {
            require(loanIdx <= type(uint32).max, "Loan index too large.");
            lpInfo.fromLoanIdx = uint32(loanIdx);
            lpInfo.sharesOverTime.push(newLpShares);
        } else {
            // update both LP arrays and check for auto increment
            updateLpArrays(lpInfo, newLpShares, true);
        }
        require(
            block.timestamp <= MAX_TIMESTAMP - MIN_LPING_PERIOD,
            "Timestamp too large."
        );
        earliestRemove = uint32(block.timestamp + MIN_LPING_PERIOD);
        lpInfo.earliestRemove = earliestRemove;
        // keep track of add timestamp per tx origin to check for atomic add and borrows/rollOvers
        lastAddOfTxOrigin[tx.origin] = block.timestamp;
    }

    /**
     * @notice Returns the repayment amount that can be reinvested without
     *         hitting the zero-share add guard.
     */
    function _reinvestableAmount(uint256 _repayments) internal view returns (uint256) {
        uint256 maxTermLiquidity = type(uint256).max / (2 * (10 ** collTokenDecimals));
        uint256 newShares;
        if (totalLiquidity != 0 &&
            !(_repayments != 0 && totalLpShares > type(uint256).max / _repayments)) {
            newShares = Math.mulDiv(_repayments, totalLpShares, totalLiquidity);
        }
        if (
            block.timestamp > MAX_TIMESTAMP - MIN_LPING_PERIOD ||
            _repayments < minLiquidity / 1000 ||
            totalLpShares == 0 ||
            totalLiquidity == 0 ||
            newShares == 0 ||
            newShares > type(uint128).max - totalLpShares ||
            uint256(totalLpShares) + newShares >= minLoan * BASE ||
            totalLiquidity > maxTermLiquidity ||
            _repayments > maxTermLiquidity - totalLiquidity
        ) return 0;
        return _repayments;
    }

    /**
     * @notice Function which updates array (and possibly array pointer) info
     *
     * @dev There are many different cases depending on if shares over time is length 1,
     * if the LP fromLoanId = loanIdx, if last value of loanIdxsWhereSharesChanged = loanIdx,
     * and possibly on the value of the penultimate shares over time array = newShares...
     * further discussion of all cases is provided in the whitepaper
     *
     * @param _lpInfo Struct of the info for the current LP
     * @param _newLpShares Amount of new LP shares to add/remove from current LP position
     * @param _add Flag that allows for addition of shares for addLiquidity and subtraction for remove
     */
    function updateLpArrays(
        LpInfo storage _lpInfo,
        uint256 _newLpShares,
        bool _add
    ) internal {
        uint256 _loanIdx = loanIdx;
        uint256 _originalSharesLen = _lpInfo.sharesOverTime.length;
        uint256 _originalLoanIdxsLen = _originalSharesLen - 1;
        uint256 currShares = _lpInfo.sharesOverTime[_originalSharesLen - 1];
        uint256 newShares;
        if (_add) {
            require(_newLpShares <= type(uint256).max - currShares, "LP shares too large.");
            newShares = currShares + _newLpShares;
        } else {
            require(currShares >= _newLpShares, "Invalid removal operation.");
            newShares = currShares - _newLpShares;
        }
        bool loanCheck = (_originalLoanIdxsLen > 0 &&
            _lpInfo.loanIdxsWhereSharesChanged[_originalLoanIdxsLen - 1] ==
            _loanIdx);
        // if LP has claimed all possible loans that were taken out (fromLoanIdx = loanIdx)
        if (_lpInfo.fromLoanIdx == _loanIdx) {
            /**
                if shares length has one value, OR
                if loanIdxsWhereSharesChanged array is non empty
                and the last value of the array is equal to current loanId
                then we go ahead and overwrite the lastShares array.
                We do not have to worry about popping array in second case
                because since fromLoanIdx == loanIdx, we know currSharePtr is
                already at end of the array, and therefore can never get stuck
            */
            if (_originalSharesLen == 1 || loanCheck) {
                _lpInfo.sharesOverTime[_originalSharesLen - 1] = newShares;
            }
            /**
            if loanIdxsWhereSharesChanged array is non empty
            and the last value of the array is NOT equal to current loanId
            then we go ahead and push a new value onto both arrays and increment currSharePtr
            we can safely increment share pointer because we know if fromLoanIdx is == loanIdx
            then currSharePtr has to already be length of original shares over time array - 1 and
            we want to keep it at end of the array 
            */
            else {
                require(_lpInfo.currSharePtr < type(uint32).max, "LP history too large.");
                pushLpArrays(_lpInfo, newShares, _loanIdx);
                unchecked {
                    _lpInfo.currSharePtr++;
                }
            }
        }
        /**
            fromLoanIdx is NOT equal to loanIdx in this case, but
            loanIdxsWhereSharesChanged array is non empty
            and the last value of the array is equal to current loanId.        
        */
        else if (loanCheck) {
            /**
                The value in the shares array before the last array
                In this case we are going to pop off the last values.
                Since we know that if currSharePtr was at end of array and loan id is still equal to last value
                on the loanIdxsWhereSharesUnchanged array, this would have meant that fromLoanIdx == loanIdx
                and hence, no need to check if currSharePtr needs to decrement
            */
            if (_lpInfo.sharesOverTime[_originalSharesLen - 2] == newShares) {
                _lpInfo.sharesOverTime.pop();
                _lpInfo.loanIdxsWhereSharesChanged.pop();
            }
            // if next to last shares over time value is not same as newShares,
            // then just overwrite last share value
            else {
                _lpInfo.sharesOverTime[_originalSharesLen - 1] = newShares;
            }
        } else {
            // if the previous conditions are not met then push newShares onto shares over time array
            // and push global loan index onto loanIdxsWhereSharesChanged
            pushLpArrays(_lpInfo, newShares, _loanIdx);
        }
    }

    /**
     * @notice Helper function that pushes onto both LP Info arrays
     *
     * @dev This function is called by updateLpArrays function in two cases when both
     * LP Info arrays, sharesOverTime and loanIdxsWhereSharesChanged, are pushed onto
     *
     * @param _lpInfo Struct of the info for the current LP
     * @param _newShares New amount of LP shares pushed onto sharesOverTime array
     * @param _loanIdx Current global loanIdx pushed onto loanIdxsWhereSharesChanged array
     */
    function pushLpArrays(
        LpInfo storage _lpInfo,
        uint256 _newShares,
        uint256 _loanIdx
    ) internal {
        require(_lpInfo.sharesOverTime.length < type(uint32).max, "LP history too large.");
        require(_loanIdx < type(uint32).max, "Loan index too large.");
        _lpInfo.sharesOverTime.push(_newShares);
        _lpInfo.loanIdxsWhereSharesChanged.push(_loanIdx);
    }

    /**
     * @notice Helper function when user is borrowing
     *
     * @dev This function is called by borrow
     *
     * @param _inAmountAfterFees Net amount of what was sent by borrower minus fees
     * @param _minLoanLimit Minimum loan currency amount acceptable to borrower
     * @param _maxRepayLimit Maximum allowable loan currency amount borrower is willing to repay
     * @param _timestamp Time that is used to set loan expiry
     *
     * @return loanAmount Amount of loan Ccy given to the borrower
     * @return repaymentAmount Amount of loan Ccy borrower needs to repay to claim collateral
     * @return pledgeAmount Amount of collCcy reclaimable upon repayment
     * @return expiry Timestamp after which loan expires
     * @return _creatorFee Protocol revenue fee levied for using the protocol
     * @return _totalLiquidity Updated total liquidity (pre-borrow)
     */
    function _borrow(
        uint128 _inAmountAfterFees,
        uint128 _minLoanLimit,
        uint128 _maxRepayLimit,
        uint256 _timestamp
    )
        internal
        view
        returns (
            uint128 loanAmount,
            uint128 repaymentAmount,
            uint128 pledgeAmount,
            uint32 expiry,
            uint256 _creatorFee,
            uint256 _totalLiquidity
        )
    {
        // get and verify loan terms
        (
            loanAmount,
            repaymentAmount,
            pledgeAmount,
            _creatorFee,
            _totalLiquidity
        ) = loanTerms(_inAmountAfterFees);
        assert(_inAmountAfterFees != 0); // if 0 must have failed in loanTerms(...)
        if (loanAmount < _minLoanLimit) revert("Loan below limit.");
        if (repaymentAmount > _maxRepayLimit) revert("Repayment above limit.");
        require(_timestamp <= MAX_TIMESTAMP - loanTenor, "Loan expiry too large.");
        uint256 expiryTimestamp = _timestamp + loanTenor;
        require(expiryTimestamp <= MAX_TIMESTAMP, "Loan expiry too large.");
        expiry = uint32(expiryTimestamp);
    }

    /**
     * @notice Helper function called whenever a function needs to check a deadline
     *
     * @dev This function is called by addLiquidity, borrow, and if reinvestment on claiming,
     * it will be called by claimReinvestmentCheck
     *
     * @param _deadline Last timestamp after which function will revert
     *
     * @return timestamp Current timestamp passed back to function
     */
    function checkTimestamp(
        uint256 _deadline
    ) internal view returns (uint256 timestamp) {
        timestamp = block.timestamp;
        if (timestamp > _deadline) revert("Past deadline.");
    }

    /**
     * @notice Helper function called whenever reinvestment is possible
     *
     * @dev This function is called by claim and claimFromAggregated if reinvestment is desired
     *
     * @param _deadline Last timestamp after which function will revert
     * @param _onBehalfOf Recipient of the reinvested LP shares
     */
    function claimReinvestmentCheck(
        uint256 _deadline,
        address _onBehalfOf
    ) internal view {
        require(!paused(), "Pausable: paused");
        _requirePoolWhitelisted();
        checkTimestamp(_deadline);
        checkSenderApproval(_onBehalfOf, IBasePool.ApprovalTypes.ADD_LIQUIDITY);
    }

    function _requirePoolWhitelisted() internal view {
        require(
            IControllerWhitelist(address(poolController)).poolWhitelisted(address(this)),
            "Pool is not whitelisted."
        );
    }

    /**
     * @notice Helper function checks if function caller is a valid sender
     *
     * @dev This function is called by addLiquidity, removeLiquidity, repay,
     * claim, claimFromAggregated, claimReinvestmentCheck (ADD_LIQUIDITY)
     *
     * @param _ownerOrBeneficiary Address which will be owner or beneficiary of transaction if approved
     * @param _approvalType Type of approval requested { REPAY, ADD_LIQUIDITY, REMOVE_LIQUIDITY, CLAIM }
     */
    function checkSenderApproval(
        address _ownerOrBeneficiary,
        IBasePool.ApprovalTypes _approvalType
    ) internal view {
        if (
            !(_ownerOrBeneficiary == msg.sender ||
                isApproved[_ownerOrBeneficiary][msg.sender][_approvalType])
        ) revert("Sender not approved.");
    }

    /**
     * @notice Returns the pool's rate given _liquidity to calculate a loan's
     * repayment amount
     *
     * @dev The rate is defined as a piecewise function with 3 ranges:
     * (1) low liquidity range: rate is defined as a reciprocal function
     * (2) target liquidity range: rate is linear
     * (3) high liquidity range: rate is constant
     * 
     * @param _liquidity Liquidity level for which the rate shall be calculated
     * 
     * @return rate Applicable rate
     */
    function getRate(uint256 _liquidity) internal view returns (uint256 rate) {
        if (_liquidity < liquidityBnd1) {
            rate = _mulDivOrMax(r1, liquidityBnd1, _liquidity);
        } else if (_liquidity <= liquidityBnd2) {
            uint256 interpolation = _mulDivOrMax(
                r1 - r2,
                liquidityBnd2 - _liquidity,
                liquidityBnd2 - liquidityBnd1
            );
            rate = interpolation > type(uint256).max - r2
                ? type(uint256).max
                : r2 + interpolation;
        } else {
            rate = r2;
        }
    }

    /**
     * @dev Returns uint256.max instead of bubbling Math.mulDiv's overflow
     *      revert. Callers can then apply their own bounded-domain error.
     */
    function _mulDivOrMax(uint256 _x, uint256 _y, uint256 _denominator)
        internal
        pure
        returns (uint256 result)
    {
        uint256 high;
        assembly {
            let mm := mulmod(_x, _y, not(0))
            let low := mul(_x, _y)
            high := sub(sub(mm, low), lt(mm, low))
        }
        if (high >= _denominator) return type(uint256).max;
        return Math.mulDiv(_x, _y, _denominator);
    }

    /**
     * @notice Saturating subtraction (floors at 0) for the reward tracker.
     * @dev Audit task P2 (finding S1). The reward tracker `lastTrackedLiquidity`
     * is credited with raw principal on add but decremented by the share-VALUE of
     * a position on exit/claim; the per-share value rises over time, so the
     * decrement can exceed the tracker. A plain checked subtraction would revert
     * (Panic 0x11) and permanently lock removeLiquidity/claim for that LP. Flooring
     * at 0 cannot over-credit rewards: the reward sent is computed on the OLD
     * tracker value (before this subtraction), and a smaller new value can only
     * under-credit the NEXT interval — never inflate `_liquidity` beyond pool
     * inflow.
     */
    function _satSub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    /**
     * @notice Internal function to update the last reward timestamp
     * and last tracked liquidity
     *
     * @param _account Account for which the reward is being updated
     * @param _newLiquidity New liquidity for the account
     *
     * @return oldLiquidity Liquidity before the update
     * @return timeSinceLastReward Time since the last reward
     */
    function _updateReward(address _account, uint256 _newLiquidity) internal returns (uint128 oldLiquidity, uint32 timeSinceLastReward) {
        uint32 previousRewardTimestamp = lastRewardTimestamp[_account];
        // Reward timestamps are intentionally capped at the LoanInfo uint32
        // ceiling. Existing positions remain exitable after that ceiling; a
        // migration can reset reward accounting for future-generation pools.
        uint256 cappedTimestamp = block.timestamp > MAX_TIMESTAMP
            ? MAX_TIMESTAMP
            : block.timestamp;
        uint128 trackedLiquidity = _newLiquidity > type(uint128).max
            ? type(uint128).max
            : uint128(_newLiquidity);

        oldLiquidity = lastTrackedLiquidity[_account];
        lastRewardTimestamp[_account] = uint32(cappedTimestamp);
        lastTrackedLiquidity[_account] = trackedLiquidity;

        if (previousRewardTimestamp == 0 || cappedTimestamp <= previousRewardTimestamp) {
            return (oldLiquidity, 0);
        }

        uint256 elapsed = cappedTimestamp - previousRewardTimestamp;
        if (elapsed > type(uint32).max) elapsed = type(uint32).max;
        timeSinceLastReward = uint32(elapsed);
    }

    /**
     * @notice Helper function to send the reward to the pool controller
     *
     * @param _account Acount for which the reward is being sent
     * @param _liquidity Liquidity of the account
     * @param _timeSinceLastReward Time since the last reward was sent
     */
    function _sendReward(address _account, uint128 _liquidity, uint32 _timeSinceLastReward) internal {
        // Retry at most the currently outstanding debt before recording a new
        // request. A failing or partially funded controller never blocks an LP
        // exit and never makes the missing reward invisible.
        if (pendingRewardDebt[_account] > 0) {
            _retryPendingReward(_account, pendingRewardDebt[_account]);
        }

        if (_liquidity == 0 || _timeSinceLastReward == 0) return;

        uint256 rewardWeight = uint256(_timeSinceLastReward) * uint256(rewardCoefficient);
        // Reward bookkeeping is optional and must never make a principal exit
        // revert if an extreme coefficient would overflow the 256-bit product.
        uint256 requested;
        if (_liquidity != 0 && rewardWeight > type(uint256).max / uint256(_liquidity)) {
            requested = type(uint256).max;
        } else {
            requested = Math.mulDiv(uint256(_liquidity), rewardWeight, BASE);
        }
        if (requested == 0) return;

        uint256 credited;
        try poolController.requestTokenDistribution(
            _account,
            _liquidity,
            _timeSinceLastReward,
            rewardCoefficient
        ) returns (uint256 amount) {
            credited = amount > requested ? requested : amount;
        } catch {
            credited = 0;
        }

        if (credited < requested) {
            uint256 missing = requested - credited;
            uint256 previousDebt = pendingRewardDebt[_account];
            pendingRewardDebt[_account] =
                missing > type(uint256).max - previousDebt
                    ? type(uint256).max
                    : previousDebt + missing;
            emit RewardDebtUpdated(
                _account,
                requested,
                credited,
                pendingRewardDebt[_account]
            );
        }
    }

    /**
     * @notice Permissionlessly retries an account's pending reward debt.
     * @param _account LP account whose pending reward is being retried.
     * @param _maxAmount Maximum debt to submit in this call.
     */
    function retryPendingReward(address _account, uint256 _maxAmount)
        external
        override
        nonReentrant
        returns (uint256 credited)
    {
        require(_maxAmount > 0, "Invalid reward amount.");
        credited = _retryPendingReward(_account, _maxAmount);
    }

    function _retryPendingReward(address _account, uint256 _maxAmount)
        internal
        returns (uint256 credited)
    {
        uint256 debt = pendingRewardDebt[_account];
        if (debt == 0 || _maxAmount == 0) return 0;
        uint256 request = debt < _maxAmount ? debt : _maxAmount;
        try poolController.requestTokenDistributionExact(_account, request) returns (uint256 amount) {
            credited = amount > request ? request : amount;
            pendingRewardDebt[_account] = debt - credited;
        } catch {
            // Rewards are optional bookkeeping; preserve debt and keep exits live.
        }
        emit RewardDebtUpdated(_account, request, credited, pendingRewardDebt[_account]);
    }

    /**
     * @notice Helper function to update the reward and send it to the pool controller
     *
     * @param _account Account for which the reward is being sent
     * @param _newLiquidity New liquidity of the account
     */
    function _updateRewardAndSend(address _account, uint256 _newLiquidity) internal {
        (uint128 oldLiquidity, uint32 timeSinceLastReward) = _updateReward(_account, _newLiquidity);
        _sendReward(_account, oldLiquidity, timeSinceLastReward);
    }

    /**
     * @notice Forces a reward update for a given account
     *
     * @param _onBehalfOf Account for which the reward is being updated
     */
    function forceRewardUpdate(address _onBehalfOf) external nonReentrant {
        checkSenderApproval(_onBehalfOf, IBasePool.ApprovalTypes.FORCE_REWARD_UPDATE);
        _updateRewardAndSend(_onBehalfOf, lastTrackedLiquidity[_onBehalfOf]);
    }

    /**
     * @notice Flushes at most `_maxAmount` of revenue that is pending in the
     *         pool. Anyone may retry a failed optional controller deposit.
     * @return flushedAmount Amount transferred to the controller.
     */
    function flushPendingRevenue(IERC20 _token, uint256 _maxAmount)
        external
        nonReentrant
        returns (uint256 flushedAmount)
    {
        require(_maxAmount > 0, "Invalid revenue amount.");
        uint256 pending = pendingRevenue[_token];
        require(pending > 0, "No pending revenue.");
        uint256 amount = pending < _maxAmount ? pending : _maxAmount;
        flushedAmount = _flushPendingRevenue(_token, amount);
    }

    function _depositRevenue(IERC20 _token, uint256 _amount) internal {
        if (_amount == 0) return;
        require(_amount <= type(uint256).max - pendingRevenue[_token], "Revenue too large.");
        pendingRevenue[_token] += _amount;
        _flushPendingRevenue(_token, _amount);
    }

    function _flushPendingRevenue(IERC20 _token, uint256 _amount) internal returns (uint256 flushedAmount) {
        uint256 pending = pendingRevenue[_token];
        if (_amount == 0 || pending == 0) return 0;
        if (_amount > pending) _amount = pending;

        try this._attemptRevenueDeposit(_token, _amount) returns (uint256 amount) {
            pendingRevenue[_token] = pending - amount;
            return amount;
        } catch {
            // Approval, controller and cleanup failures are all optional. The
            // external self-call rolls their state back before this catch.
            return 0;
        }
    }

    /**
     * @dev Isolates optional token approval, controller deposit and allowance
     *      cleanup so any failure can be atomically caught by the caller.
     */
    function _attemptRevenueDeposit(IERC20 _token, uint256 _amount)
        external
        returns (uint256 flushedAmount)
    {
        require(msg.sender == address(this), "Self call only.");
        uint256 poolBefore = _token.balanceOf(address(this));
        if (poolBefore < _amount) return 0;

        _token.safeIncreaseAllowance(address(poolController), _amount);
        poolController.depositRevenue(_token, _amount);
        uint256 poolAfter = _token.balanceOf(address(this));
        _token.safeApprove(address(poolController), 0);

        if (poolBefore < poolAfter) revert("Unsupported token behavior.");

        // A trusted Controller transfers exactly `_amount`. If an optional
        // controller accepts a fee-on-transfer token and reports success,
        // account only the measured amount so pool balance plus pending
        // revenue remains conserved instead of making the shortfall invisible.
        flushedAmount = poolBefore - poolAfter;
        // A controller cannot consume more than its exact temporary allowance.
        // Revert if a token callback/rebase violates that invariant; reverting
        // also rolls back any external transfer made by the malformed call.
        if (flushedAmount > _amount) revert("Unsupported token behavior.");
        return flushedAmount;
    }

    function _transferFromExact(IERC20 _token, address _from, uint256 _amount) internal {
        uint256 fromBefore = _token.balanceOf(_from);
        uint256 poolBefore = _token.balanceOf(address(this));
        _token.safeTransferFrom(_from, address(this), _amount);
        uint256 fromAfter = _token.balanceOf(_from);
        uint256 poolAfter = _token.balanceOf(address(this));
        require(
            fromBefore >= fromAfter && fromBefore - fromAfter == _amount &&
                poolAfter >= poolBefore && poolAfter - poolBefore == _amount,
            "Unsupported token behavior."
        );
    }

    function _transferExact(IERC20 _token, address _to, uint256 _amount) internal {
        uint256 poolBefore = _token.balanceOf(address(this));
        uint256 recipientBefore = _token.balanceOf(_to);
        _token.safeTransfer(_to, _amount);
        uint256 poolAfter = _token.balanceOf(address(this));
        uint256 recipientAfter = _token.balanceOf(_to);
        require(
            poolBefore >= poolAfter && poolBefore - poolAfter == _amount &&
                recipientAfter >= recipientBefore && recipientAfter - recipientBefore == _amount,
            "Unsupported token behavior."
        );
    }

    function _readTokenDecimals(IERC20 _token) internal view returns (uint256 decimals) {
        try IERC20Metadata(address(_token)).decimals() returns (uint8 value) {
            decimals = value;
        } catch {
            revert("Token decimals unavailable.");
        }
    }

    /**
     * @inheritdoc IPausable
     */
    function pause () external override {
        require(msg.sender == address(poolController), "Not the controller.");
        _pause();
    }

    /**
     * @inheritdoc IPausable
     */
    function unpause () external override {
        require(msg.sender == address(poolController), "Not the controller.");
        _unpause();
    }


    // The following is an instruction for the custom preprocessor implemented in unit tests
    // It adds two methods (getTime() and setTime(uint256)) which allow to manipulate the
    // block.timestamp value in tests

    // TMP-TIMESTAMP-METHODS
}
