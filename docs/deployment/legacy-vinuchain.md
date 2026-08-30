# Legacy VinuChain deployment record

This document is the verification record for the immutable `legacy-mainnet-v1`
generation. The machine-readable source of truth is
[`deployments/vinuchain-legacy.json`](../../deployments/vinuchain-legacy.json).
Do not use the illustrative values in the generic deployment guide for this
generation.

## Network and release identity

| Field | Value |
| --- | --- |
| Network | VinuChain |
| Chain ID | `207` |
| RPC | `https://rpc.vinuchain.org` |
| Explorer | `https://vinuexplorer.org` |
| Event scan lower bound | Block `100000` |
| Observation | Block `14707477`, timestamp `1788069122` (`2026-08-30T05:52:02Z`) |
| Generation | `legacy-mainnet-v1` |

The read-only reconciler checks the current head by default:

```bash
node scripts/reconcile-legacy.mjs --json
node scripts/reconcile-legacy.mjs --json --block 14707477
```

The historical form requires an archive-capable RPC. A pruned endpoint may
return `missing trie node`; that is an unavailable historical read, not proof
that the state changed.

## Core contracts and helpers

| Contract | Address | Creation block | Runtime bytes | Runtime Keccak-256 | Explorer source status |
| --- | --- | ---: | ---: | --- | --- |
| Controller | `0x17bA239f2815BA01152522521737275a2439216f` | 164725 | 11969 | `0xb2315e088506da1a6c8ff4d166ba30510fdff26c3f7a578264e6964bd66d49e8` | Partial |
| MultiClaim | `0xA260d19aEe266cC85F41f160271F9C72ea8E2837` | 118882 | 2631 | `0x7418c30808f2c917606cd9e1a8699c4fb339685b29c4569866ac9dad7daacf50` | Full |
| EmergencyWithdrawal | `0xeBC1C9Ae7FC761330929d682d97334513C1FcB4b` | 142906 | 3128 | `0xc8079b7196f9f8caea177ac091688377616c8ad3eb2a84f476738423f5c0424a` | Full |

The Controller constructor is eight arguments, in this exact order:

```bash
npx hardhat verify --network vinuchain \
  0x17bA239f2815BA01152522521737275a2439216f \
  0xed8c5530a0A086a12f57275728128a60DFf04230 \
  2000 3000 6000 4000 100 10 \
  0xe56e67774d965c10193375fd953d2e1e2f802d16
```

The vote token is WVC. The effective veto holder and original pool deployer
are `0xe56e67774d965c10193375fd953d2e1e2f802d16`. MultiClaim and
EmergencyWithdrawal have no constructor arguments:

```bash
npx hardhat verify --network vinuchain \
  0xA260d19aEe266cC85F41f160271F9C72ea8E2837
npx hardhat verify --network vinuchain \
  0xeBC1C9Ae7FC761330929d682d97334513C1FcB4b
```

## Tokens

| Token | Address | Decimals | Creation block | Runtime bytes | Explorer source status |
| --- | --- | ---: | ---: | ---: | --- |
| WVC (`Wrapped VC`) | `0xEd8c5530a0A086a12f57275728128a60DFf04230` | 18 | 115872 | 3249 | Partial |
| USDT (`USDT@VinuChain`) | `0xC0264277fcCa5FCfabd41a8bC01c1FcAF8383E41` | **6** | 5889 | 8822 | None |
| VINU (`Vita Inu`) | `0x00c1E515EA9579856304198EFb15f525A0bb50f6` | 18 | 5983 | 2570 | Partial |

## Pool constructor verification

Every pool uses the current `BasePool` constructor with eleven arguments:

```text
[_loanToken, _collateralToken], _collTokenDecimals, _loanTenor,
_maxLoanPerColl, [_r1, _r2], [_liquidityBnd1, _liquidityBnd2], _minLoan,
_creatorFee, _minLiquidity, _poolController, _rewardCoefficient
```

All ten pools use `loanTenor=2592000`, `r1=50000000000000000`,
`r2=20000000000000000`, `liquidityBnd1=10000000000000000000`,
`liquidityBnd2=100000000000000000000`, `minLoan=200000000000000000`,
`creatorFee=15000000000000000`, `minLiquidity=1000000000000000000`,
Controller `0x17bA239f2815BA01152522521737275a2439216f`, and
`rewardCoefficient=0`. Use the exact per-pool values below for the remaining
arguments:

| Pool | Address | Tokens `[loan, collateral]` | `_collTokenDecimals` | `_maxLoanPerColl` |
| --- | --- | --- | ---: | ---: |
| WVC/USDT 1 | `0xfeec5A79D8f6d0CcC9f55Ed96cf985501CC4Db37` | `[WVC, USDT]` | 18 | `10743776284000000000` |
| VINU/USDT 1 | `0x2Eb1970dc38AfF84735cf965126ec5044197285C` | `[VINU, USDT]` | 18 | `46983018994563400000000000` |
| VINU/WVC 1 | `0x68EA6F302e1bFDEbCC6336e7309463c97c100a05` | `[VINU, WVC]` | 18 | `1749218068326733000000000` |
| WVC/VINU 1 | `0xB8F54383b78FAb60D2eCedc59B5cde9a6ae655d1` | `[WVC, VINU]` | 18 | `91000000000` |
| WVC/USDT 2 | `0xF0e98da5EF7CA6aD88E42cD3fc47546B10618F1b` | `[WVC, USDT]` | **6** | `12968726842000000000` |
| VINU/USDT 2 | `0x81FF52B811F13548782B4dfBff604045F4786dfb` | `[VINU, USDT]` | **6** | `54402735680422792000000000` |
| WVC/USDT 3 | `0x02C9888b942FC237f413d759663F4415FC8A80FB` | `[WVC, USDT]` | **6** | `13645224172000000000` |
| VINU/USDT 3 | `0x2111Bcd337dcbF62F02A93b758030673f0458fe9` | `[VINU, USDT]` | **6** | `27127577119826384000000000` |
| VINU/WVC 2 | `0xfE3BcC21F7a48F23C149a0730DA275f42dc8b1e0` | `[VINU, WVC]` | 18 | `795225546426911000000000` |
| WVC/VINU 2 | `0x0e603483590134f31a67A9D43e7d04193E80e482` | `[WVC, VINU]` | 18 | `201000000000` |

For a pool, write a temporary constructor-arguments file from the manifest;
never hand-copy the generic example's decimals or loan units:

```javascript
module.exports = [
  ["LOAN_TOKEN", "COLLATERAL_TOKEN"],
  COLLATERAL_DECIMALS,
  2592000,
  "MAX_LOAN_PER_COLL",
  ["50000000000000000", "20000000000000000"],
  ["10000000000000000000", "100000000000000000000"],
  "200000000000000000",
  "15000000000000000",
  "1000000000000000000",
  "0x17bA239f2815BA01152522521737275a2439216f",
  "0"
];
```

Then run:

```bash
npx hardhat verify --network vinuchain \
  --constructor-args arguments.js POOL_ADDRESS
```

All ten BasePool addresses were unverified at the observation. Do not record a
pool as source-verified until the explorer reports full verification and the
verified compiler settings and constructor arguments match the manifest.
