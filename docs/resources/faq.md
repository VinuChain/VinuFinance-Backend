# FAQ

Frequently asked questions about VinuFinance.

## General

### What is VinuFinance?

VinuFinance is a decentralized lending protocol on VinuChain that offers **Zero Liquidation Loans**. Unlike traditional DeFi lending, borrowers are never liquidated - they can either repay their loan to reclaim collateral, or forfeit the collateral if they choose not to repay.

### How is this different from Aave or Compound?

| Feature | Traditional Lending | VinuFinance |
|---------|---------------------|-------------|
| Liquidation | Yes, at any time | No, never |
| Interest | Variable, ongoing | Fixed, upfront |
| Loan Term | Indefinite | Fixed duration |
| Collateral Recovery | Depends on liquidation | Always possible if repaid |
| Oracle Dependency | Yes | No |

### Is VinuFinance audited?

The contracts are based on Myso Finance v1 with additional features. See [Security](security.md) for audit status.

### What blockchain is VinuFinance on?

VinuFinance is deployed on **VinuChain** (Chain ID: 207).

## For Borrowers

### How do Zero Liquidation Loans work?

1. You pledge collateral to the pool
2. You receive a fixed-term loan with predetermined repayment amount
3. Before expiry: Repay to get your collateral back
4. After expiry: Your collateral is forfeited to LPs, you keep the loan

### What happens if I don't repay?

Your collateral is distributed to liquidity providers. You keep the borrowed tokens. There's no additional penalty, debt, or reputation impact.

### Can I repay early?

Yes! You can repay anytime before the loan expires. The repayment amount is fixed from the start - no early repayment penalty.

### Can I repay partially?

No, VinuFinance requires full repayment to reclaim collateral. Partial repayments are not supported.

### What's the minimum loan amount?

Each pool has its own minimum loan amount (minLoan). Check the pool parameters before borrowing.

### How is the interest rate determined?

Interest rates are calculated at borrow time based on pool utilization. Higher utilization = higher rates. The rate is fixed for your loan's duration.

### What if the pool is paused?

If paused, you cannot take new loans, but you can still repay existing loans to reclaim collateral.

## For Liquidity Providers

### How do I earn as an LP?

1. **Interest from repayments** - When borrowers repay, you get your share of principal + interest
2. **Collateral from defaults** - When borrowers don't repay, you get their collateral
3. **LP rewards** - If the pool is whitelisted, you earn additional token rewards

### How are my returns calculated?

Your returns are proportional to your share of the pool at the time each loan was made:

```
Your Return = (Your Shares / Total Shares) × Loan Returns
```

### What risks do LPs face?

1. **Smart contract risk** - Potential bugs in contracts
2. **Collateral value risk** - Defaulted collateral may be worth less than the loan
3. **Liquidity risk** - Your funds may be locked in active loans

### Can I withdraw anytime?

You can withdraw liquidity that isn't locked in active loans. After the 120-second minimum period, you can remove your shares. However, if most liquidity is lent out, you may need to wait for loans to settle.

### What's the minimum lock period?

120 seconds after depositing. This prevents flash loan attacks.

### How do I claim my earnings?

Call the `claim` function with the loan indices you want to claim from. See [Claiming Guide](../guides/claiming.md).

### Should I reinvest my claims?

Reinvesting (`_isReinvested = true`) compounds your returns by automatically adding claimed repayments back to your LP position. It saves gas compared to claim + deposit separately.

## For Governance Participants

### How do I vote on proposals?

1. Deposit governance tokens in the Controller
2. Call `vote(proposalIdx)` on any active proposal
3. Your vote weight equals your deposited balance

### What can governance control?

- **PAUSE/UNPAUSE** - Emergency stop for pools
- **WHITELIST/DEWHITELIST** - Enable/disable LP rewards for pools

### How do I earn protocol revenue?

Deposit governance tokens and claim your share of accumulated fees via `claimToken()`. Revenue comes from protocol fees on all pools.

### What is the veto holder?

A special address that must approve WHITELIST/DEWHITELIST proposals. This provides an extra safety layer for reward distribution.

## Technical

### Why no oracles?

VinuFinance intentionally avoids price oracles to eliminate oracle manipulation risks. The tradeoff is that loan-to-value ratios are fixed at pool creation rather than dynamically adjusted.

### What tokens can be used?

Any ERC20 token can be used for loan currency or collateral. However, tokens should be:
- Standard ERC20 (no fee-on-transfer, rebasing, etc.)
- Have sufficient liquidity for price discovery
- Be verified and trusted

### What are the gas costs?

| Operation | Approximate Gas |
|-----------|-----------------|
| Add Liquidity | ~200,000 |
| Remove Liquidity | ~150,000 |
| Borrow | ~250,000 |
| Repay | ~150,000 |
| Claim (per loan) | ~50,000 |

### Is there a frontend?

Check the official VinuFinance website for the current UI. You can also interact directly with contracts.

## Troubleshooting

### "Invalid add amount"

The deposit is below the pool minimum (`minLiquidity / 1000`) or otherwise invalid. Check:
- Amount is greater than zero
- Amount doesn't exceed your balance
- Amount meets pool minimum requirements

### "Insufficient liquidity"

The pool doesn't have enough liquidity for your loan request. Try:
- Requesting a smaller loan
- Waiting for more liquidity to be added
- Checking a different pool

### "Not the controller"

You're trying to call a controller-only function. Only the Controller contract can pause/unpause pools.

### "Deadline passed"

Your transaction deadline has expired. Submit a new transaction with a future deadline.

### "Loan tenor too small"

The pool's loan duration is below the minimum (86,400 seconds = 1 day).

### "Too early to remove"

You must wait at least 120 seconds after depositing before removing liquidity.

### "Nothing to claim"

Either:
- You've already claimed from these loans
- The loans haven't settled yet
- You weren't an LP when these loans were made

### Transaction reverts without reason

- Check you have enough balance for the transaction
- Verify token approvals
- Ensure deadline hasn't passed
- Check the pool isn't paused (for borrow operations)

## Getting Help

### Where can I get support?

- **Documentation**: You're reading it!
- **Discord**: Join the VinuFinance community
- **Twitter**: @VinuFinance
- **GitHub**: Report issues on the repository

### How do I report a bug?

For security vulnerabilities, email security@vinufinance.io. For other bugs, open an issue on GitHub.

### Where can I see pool statistics?

Check the frontend dashboard or query contracts directly:
- `getPoolInfo()` - Pool parameters and totals
- `getRateParams()` - Interest rate settings
- `getLpInfo(address)` - Individual LP position

## Related

- [Core Concepts](../overview/concepts.md)
- [Providing Liquidity](../guides/providing-liquidity.md)
- [Borrowing](../guides/borrowing.md)
- [Security](security.md)
