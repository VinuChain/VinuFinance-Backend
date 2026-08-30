# VinuFinance-VinuChain

VinuChain port of [mysofinance/v1-core-protocol](https://github.com/mysofinance/v1-core-protocol), with extra features such as emergency stop support and LP rewards.


# Installing

```
git clone https://github.com/Vita-Inu/VinuFinance-VinuChain
cd VinuFinance-VinuChain
corepack enable
yarn install --frozen-lockfile
```

The repository pins Yarn 1.22.22 via `package.json#packageManager` and
requires Node.js 20 or newer. The canonical Solidity build uses solc 0.8.36,
the Cancun EVM target, optimizer runs 200, and Yul enabled; Foundry uses the
same settings for its invariant harness.

# Running Tests

```
yarn test
```
