# Controller

The Controller contract manages governance, revenue distribution, and LP rewards for VinuFinance.

**Source:** `contracts/Controller.sol`

## Overview

The Controller serves three main purposes:
1. **Governance** - Token-weighted voting on protocol proposals
2. **Revenue Distribution** - Distribute protocol fees to stakers
3. **LP Rewards** - Distribute reward tokens to liquidity providers

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `THRESHOLD_BASE` | 10000 | Base for threshold calculations |
| `COMPLEX_TIMESTAMP_COEFFICIENT` | 1000000 | Sub-timestamp multiplier |
| `REWARD_BASE` | 10^18 | Precision for reward calculations |

## State Variables

### Governance Configuration

| Variable | Type | Description |
|----------|------|-------------|
| `voteToken` | `IERC20` | Token used for voting and rewards |
| `pauseThreshold` | `uint256` | Votes needed to pause (in THRESHOLD_BASE) |
| `unpauseThreshold` | `uint256` | Votes needed to unpause |
| `whitelistThreshold` | `uint256` | Votes needed to whitelist |
| `dewhitelistThreshold` | `uint256` | Votes needed to dewhitelist |
| `lockPeriod` | `uint256` | Seconds before withdrawal allowed |
| `vetoHolder` | `address` | Address with veto power |
| `basePoolCreationCodeHash` | `bytes32` | Immutable `keccak256(type(BasePool).creationCode)` |

### Voting State

| Variable | Type | Description |
|----------|------|-------------|
| `voteTokenTotalSupply` | `uint256` | Total staked vote tokens |
| `voteTokenBalance` | `mapping(address => uint256)` | User vote token balances |
| `numProposals` | `uint256` | Total proposals created |
| `numVotings` | `mapping(address => uint256)` | Active votes per user |

### Revenue Distribution

| Variable | Type | Description |
|----------|------|-------------|
| `snapshotTokenEvery` | `uint256` | Seconds between snapshots |
| `currentRevenue` | `mapping(IERC20 => uint256)` | Uncaptured revenue per token |
| `numTokenSnapshots` | `mapping(IERC20 => uint256)` | Snapshot count per token |

### LP Rewards

| Variable | Type | Description |
|----------|------|-------------|
| `rewardSupply` | `uint256` | Available reward tokens |
| `rewardBalance` | `mapping(address => uint256)` | Uncollected rewards per user |
| `poolWhitelisted` | `mapping(address => bool)` | Pool whitelist status |
| `poolRegistered` | `mapping(address => bool)` | Pools constructed by this Controller |

## Functions

### Pool Construction

#### createPool

```solidity
function createPool(bytes calldata creationCode, bytes calldata encodedParams) external returns (address pool)
```

Constructs a canonical `BasePool` bound to this Controller and records its
construction provenance. The Controller constructor derives
`basePoolCreationCodeHash` as `keccak256(type(BasePool).creationCode)`; it is
not a constructor argument. `creationCode` must be the exact `BasePool`
creation bytecode (without constructor arguments). `encodedParams` must be
`abi.encode` of the BasePool constructor values in this order: `tokens`,
`collTokenDecimals`, `loanTenor`, `maxLoanPerColl`, `rs`, `liquidityBnds`,
`minLoan`, `creatorFee`, `minLiquidity`, `poolController` (this Controller),
and `rewardCoefficient`. After deployment, the Controller checks the pool's
Controller binding and records it in `poolRegistered`; only those registered
pools can later be whitelisted.

Direct `BasePool` deployments remain useful for isolated tests and for legacy
read-only analysis, but cannot be newly whitelisted by this Controller.
Deployment verification must confirm `basePoolCreationCodeHash` matches the
audited release artifact's `BasePool` creation code.

### Vote Token Management

#### depositVoteToken

```solidity
function depositVoteToken(uint256 _amount) external payable
```

Stakes vote tokens to participate in governance.

**Parameters:**
- `_amount` - Amount of tokens to stake

**Effects:**
- Transfers tokens from sender
- Increases voting power
- Takes account snapshot
- Resets lock period

---

#### withdrawVoteToken

```solidity
function withdrawVoteToken(uint256 _amount) external
```

Withdraws staked vote tokens.

**Reverts if:**
- Amount is zero
- User has active votes
- Lock period not elapsed
- Insufficient balance

---

### Governance

#### createProposal

```solidity
function createProposal(
    IPausable _target,
    Action _action,
    uint256 _deadline
) external
```

Creates a new governance proposal.

**Parameters:**
- `_target` - Contract to act upon
- `_action` - Action type (PAUSE, UNPAUSE, WHITELIST, DEWHITELIST)
- `_deadline` - Voting deadline

**Example:**

```javascript
// Create proposal to whitelist a pool
await controller.createProposal(
    poolAddress,
    2, // Action.WHITELIST (enum: PAUSE=0, UNPAUSE=1, WHITELIST=2, DEWHITELIST=3)
    Math.floor(Date.now() / 1000) + 7 * 24 * 3600 // 7 days
);
```

---

#### vote

```solidity
function vote(uint256 _proposalIdx) external
```

Casts votes on a proposal.

**Effects:**
- Adds user's voting power to proposal
- Increments user's active vote count
- May execute proposal if threshold reached

**Reverts if:**
- Invalid proposal index
- No voting power
- Already voted
- Proposal expired or executed

---

#### removeVote

```solidity
function removeVote(uint256 _proposalIdx) external
```

Removes vote from a proposal.

---

#### setVetoHolderApproval

```solidity
function setVetoHolderApproval(uint256 _proposalIdx, bool _approve) external
```

Approves or rejects a whitelist proposal. **Only callable by veto holder.**

---

#### transferVetoPower

```solidity
function transferVetoPower(address _newHolder, bool transferToZero) external
```

Transfers veto power to new address. **Only callable by current veto holder.**

---

### Revenue Distribution

#### depositRevenue

```solidity
function depositRevenue(IERC20 _token, uint256 _amount) external payable
```

Deposits protocol revenue for distribution. Called by pools when fees are collected.

**Effects:**
- Transfers tokens from sender
- Adds to current revenue
- May trigger snapshot

---

#### forceTokenSnapshotCheck

```solidity
function forceTokenSnapshotCheck(IERC20 _token) external
```

Forces a token snapshot to be taken if conditions are met.

---

#### claimToken

```solidity
function claimToken(
    IERC20 _token,
    uint256 _tokenSnapshotIdx,
    uint256 _accountSnapshotIdx
) public
```

Claims revenue from a specific token snapshot.

**Parameters:**
- `_token` - Token to claim
- `_tokenSnapshotIdx` - Index of token snapshot
- `_accountSnapshotIdx` - Index of account snapshot (must be active at token snapshot time)

---

#### claimMultiple

```solidity
function claimMultiple(
    IERC20[] memory _tokens,
    uint256[] memory _tokenSnapshotIdxs,
    uint256[] memory _accountSnapshotIdxs
) external
```

Claims from multiple snapshots in one transaction.

---

### LP Rewards

#### depositRewardSupply

```solidity
function depositRewardSupply(uint256 _amount) external payable
```

Deposits tokens to fund LP rewards.

---

#### requestTokenDistribution

```solidity
function requestTokenDistribution(
    address _account,
    uint128 _liquidity,
    uint32 _duration,
    uint96 _rewardCoefficient
) external
```

Requests reward distribution for an LP. **Only callable by whitelisted pools.**

**Reward Calculation:**
```
reward = liquidity × duration × rewardCoefficient / REWARD_BASE
```

---

#### collectReward

```solidity
function collectReward(bool _deposit) external
```

Collects accumulated LP rewards.

**Parameters:**
- `_deposit` - If true, auto-stake rewards; if false, transfer to user

---

## View Functions

### getProposal

```solidity
function getProposal(uint256 _proposalIdx) external view returns (
    IPausable _target,
    Action _action,
    uint256 _totalVotes,
    address _vetoApprover,
    bool _executed,
    uint256 _deadline
)
```

Returns proposal details.

---

### getProposalVotes

```solidity
function getProposalVotes(uint256 _proposalIdx, address _voter) external view returns (uint256)
```

Returns votes cast by a specific address.

---

### getAccountSnapshot

```solidity
function getAccountSnapshot(address _account, uint256 _accountSnapshotIdx) external view returns (
    uint256 _voteTokenBalance,
    uint256 _timestamp,
    uint256 _subTimestamp
)
```

Returns account snapshot data.

---

### getTokenSnapshot

```solidity
function getTokenSnapshot(IERC20 _token, uint256 _tokenSnapshotIdx) external view returns (
    uint256 _voteTokenTotalSupply,
    uint256 _collectedRevenue,
    uint256 _claimedRevenue,
    uint256 _timestamp,
    uint256 _subTimestamp
)
```

Returns token snapshot data.

---

### hasClaimedSnapshot

```solidity
function hasClaimedSnapshot(IERC20 _token, uint256 _tokenSnapshotIdx, address _account) external view returns (bool)
```

Checks if an account has claimed from a snapshot.

---

## Action Types

```solidity
enum Action {
    PAUSE,      // Pause a pool (stops borrowing)
    UNPAUSE,    // Unpause a pool
    WHITELIST,  // Enable pool for LP rewards
    DEWHITELIST // Disable pool LP rewards
}
```

## Events

| Event | Description |
|-------|-------------|
| `PoolCreated` | Canonical BasePool constructed and registered |
| `ProposalCreated` | New proposal created |
| `Voted` | Vote cast on proposal |
| `Cancelled` | Vote removed from proposal |
| `Executed` | Proposal executed |
| `DepositedVoteToken` | Vote tokens staked |
| `WithdrawnVoteToken` | Vote tokens unstaked |
| `TokenSnapshotPerformed` | Revenue snapshot taken |
| `TokenClaimed` | Revenue claimed |
| `VetoPowerTransfer` | Veto holder changed |
| `VetoHolderApproval` | Whitelist proposal approved/rejected |
| `Reward` | LP reward distributed |

## Governance Thresholds

| Action | Typical Threshold | Notes |
|--------|-------------------|-------|
| PAUSE | 20-30% | Emergency action |
| UNPAUSE | 30-40% | Restore operations |
| WHITELIST | 50%+ | Requires veto approval |
| DEWHITELIST | 30-40% | Remove pool from rewards |

## Related

- [IController Interface](../interfaces/icontroller.md)
- [Governance Guide](../../guides/governance.md)
- [BasePool Reference](base-pool.md)
