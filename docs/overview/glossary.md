# Glossary

Key terms and definitions used throughout VinuFinance documentation.

## A

### Available Liquidity
The amount of loan currency in a pool that can be borrowed. Calculated as `totalLiquidity - minLiquidity`.

### Approval
Permission granted by a user to another address to perform operations on their behalf (add liquidity, remove liquidity, claim, repay, etc.).

## B

### BASE
The precision constant used for rate and fee calculations. Equal to `10^18` (1e18).

### BasePool
The core lending pool contract that handles liquidity provision, borrowing, repayment, and claiming.

## C

### Claim
The action of collecting LP's share of repayments or defaulted collateral from settled loans.

### Collateral Currency (collCcyToken)
The token type pledged by borrowers as security for loans. If the borrower doesn't repay, LPs receive the collateral.

### Controller
The governance contract managing proposals, voting, revenue distribution, pool whitelisting, and LP rewards.

### Creator Fee
A fee (max 3%) deducted from collateral when borrowing. Sent to protocol treasury via the Controller.

## D

### Deadline
A timestamp parameter that causes transactions to revert if the current time exceeds it. Prevents stale transactions.

### Default
When a borrower does not repay their loan by the expiry time. The collateral is forfeited to LPs.

## E

### Expiry
The timestamp after which a loan can no longer be repaid. If the borrower doesn't repay before expiry, they forfeit their collateral.

### EmergencyWithdrawal
A helper contract allowing approved escrows to withdraw LP funds in emergency situations.

## F

### fromLoanIdx
The earliest loan index from which an LP can claim. Updates after each claim.

## G

### Governance
The system by which token holders vote on protocol decisions through the Controller contract.

## I

### Interest Rate
The fee borrowers pay for loans. Determined by the dynamic rate model based on pool utilization.

## L

### Liquidity Bounds (liquidityBnd1, liquidityBnd2)
Parameters defining the boundaries of the target liquidity range for interest rate calculations.

### Loan Currency (loanCcyToken)
The token type that LPs deposit and borrowers receive. Typically a stablecoin like USDT.

### Loan Index (loanIdx)
A unique identifier for each loan in a pool. Increments with each new loan.

### Loan Tenor
The duration of a loan in seconds. Minimum is 86,400 seconds (1 day).

### LP (Liquidity Provider)
A user who deposits loan currency into a pool to earn yield from borrowers.

### LP Shares
Tokens representing an LP's proportional ownership of a pool's liquidity and claims.

## M

### MaxLoanPerColl
The maximum amount of loan currency that can be borrowed per unit of collateral.

### MinLiquidity
The minimum amount of liquidity that must remain in a pool. Ensures the pool can always function.

### MIN_LPING_PERIOD
The minimum time (120 seconds) between adding and removing liquidity. Prevents flash loan attacks.

### MIN_TENOR
The minimum loan duration (86,400 seconds = 1 day).

### MultiClaim
A helper contract allowing LPs to claim multiple non-consecutive loans in a single transaction.

## P

### Pausable
Pools can be paused by the Controller (via governance), which prevents new borrowing but allows other operations.

### Pool
An instance of BasePool with specific loan currency, collateral currency, and rate parameters.

### Proposal
A governance action submitted to the Controller for voting (pause, unpause, whitelist, dewhitelist).

## R

### r1
The interest rate at the start of the target liquidity range. Higher than r2.

### r2
The minimum interest rate (end of target range). Applied when liquidity is abundant.

### Referral Code
An optional identifier passed during liquidity addition or borrowing for tracking referrals.

### Reinvest
Option for LPs to automatically deposit their claimed repayments back into the pool instead of withdrawing.

### Repayment
The amount of loan currency a borrower must return to reclaim their collateral. Equal to loan amount plus interest.

### Reward Coefficient
A pool parameter determining how many reward tokens LPs earn per unit of liquidity over time.

## S

### Snapshot
A record of token balances or revenue at a specific point in time. Used for revenue distribution.

### Share Pointer (currSharePtr)
An index tracking which element of an LP's shares array is currently active.

### Shares Over Time
An array tracking an LP's share balance at different points in time for accurate claim calculations.

## T

### Token Snapshot
A Controller snapshot recording total vote token supply and collected revenue for distribution.

### Total Liquidity
The sum of all deposits in a pool (including amounts lent out but expected back from repayments).

### Total LP Shares
The sum of all LP shares across all liquidity providers in a pool.

## V

### Veto Holder
An address with power to approve or reject pool whitelist proposals. Provides security check for new pools.

### Vote Token
The token staked in the Controller to participate in governance and earn protocol revenue.

### Voting Power
The number of votes a user can cast, equal to their staked vote token balance.

## W

### Whitelist
A pool must be whitelisted by the Controller to distribute LP rewards. Requires governance vote and veto holder approval.

### WVC
Wrapped VinuChain - The wrapped version of VinuChain's native token (VC).

## Z

### Zero Liquidation Loan
VinuFinance's core innovation - loans that cannot be liquidated. Borrowers either repay or forfeit collateral.
