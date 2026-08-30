# Dependency audit policy

CI runs Yarn's audit twice: once for the runtime graph (`--groups
dependencies`) and once for the complete Hardhat/Foundry toolchain. The gate in
`scripts/audit_gate.js` always rejects critical advisories and rejects every
high advisory except the exact upstream paths listed below. Low and moderate
findings are printed in the report; they are not hidden or converted into a
false clean result.

The current live audit has no critical findings. Runtime `ethers` is promoted
to `dependencies` because the reconciler needs its signer/provider APIs, so the
runtime graph includes the Ethers 5 WebSocket dependency. The current counts
must be read from the CI report rather than assumed: lower-severity findings
can change as the registry advisory database changes.

## Explicit high-severity exceptions

These are development or operator-tool paths constrained by upstream package
ranges. They are exceptions to the high-severity gate, not resolutions or
claims that the full graph is clean.

| Advisory path | Why it remains | Scope assumption |
| --- | --- | --- |
| `mocha>serialize-javascript` and `hardhat>mocha>serialize-javascript` | Mocha/Hardhat 2 declare the 6.x range; patched 7.x is outside that declared range. | Test-runner serialization only; no production service imports Mocha. |
| `hardhat>solc>tmp` | Hardhat 2.29.1's bundled solc path declares `tmp` 0.0.33; the patched 0.2.x line is not a declared-compatible upgrade. | Hardhat controls compiler invocation and the compiler package is dev-only. No user-controlled temp prefix is passed by this repository. |
| `hardhat>adm-zip` | Hardhat 2.29.1 declares `adm-zip` `^0.4.16`; patched 0.6.x is outside that range. | Hardhat's own archive handling only; no production ZIP input. |
| `@nomicfoundation/hardhat-verify>undici` | The official Hardhat 2 verification plugin declares undici 5.x; patched 6.x is outside its range. | Verification is an explicit operator action against the fixed VinuExplorer URL, not a runtime request path. |
| `@ethersproject/providers>ws` and `ethers>@ethersproject/providers>ws` | Ethers 5.8 pins ws 8.18.0 exactly; patched 8.21.x would violate that package declaration and fail `yarn check --verify-tree`. | Runtime source uses HTTP RPC; the Ethers WebSocket transport is retained only for the dependency's supported API surface. |

The lockfile applies only range-compatible updates for word-wrap (1.2.5), AJV
(8.20.0), bn.js 4.x requests (4.12.5), and bn.js 5.x requests (5.2.5). The exact
bn.js 4.11.6 requests remain separate and are reported honestly. The current
runtime form-data is 4.0.6 through axios (already newer than the 2.5.6 patched
floor). Other upstream-constrained advisories remain visible with their exact
paths in the audit JSONL output.

The lower-severity residual paths in the current report are also reviewed, not
silently suppressed:

- `hardhat>@sentry/node>cookie`
- `hardhat>solc>tmp`
- `mocha>diff` and `hardhat>mocha>diff`
- `mocha>serialize-javascript` and `hardhat>mocha>serialize-javascript`
- `hardhat>uuid` and `typechain>ts-command-line-args>@morgan-stanley/ts-mocking-bird>uuid`
- `@nomicfoundation/hardhat-verify>undici`
- `@ethersproject/providers>ws` and `ethers>@ethersproject/providers>ws`
- `solidity-coverage>web3-utils>ethjs-unit>bn.js`,
  `solidity-coverage>web3-utils>number-to-bn>bn.js`, and
  `solidity-coverage>web3-utils>ethjs-unit>number-to-bn>bn.js`
- Ethers' nested `@ethersproject/signing-key>elliptic` paths (including the
  provider, ABI, wallet, and Hardhat matcher paths); the registry currently
  reports no patched elliptic release, while the lock uses the latest 6.x
  release allowed by its declaration.

These are all dev-tool paths except the Ethers provider/elliptic paths. The
repository's runtime code uses HTTP RPC and does not expose WebSocket,
serialize-javascript, ZIP, or arbitrary compiler-temp inputs to users. The
operator must still review the full audit report whenever a dependency or
registry advisory changes.

For a reproducible local check:

```bash
yarn install --frozen-lockfile
yarn check --verify-tree
audit_dir="$(mktemp -d)"
set +e
yarn audit --groups dependencies --json > "$audit_dir/production.jsonl"
yarn audit --json > "$audit_dir/full.jsonl"
set -e
node scripts/audit_gate.js "$audit_dir/production.jsonl" production
node scripts/audit_gate.js "$audit_dir/full.jsonl" full
```

Use a private temporary directory for the audit reports. Never commit audit
output, credentials, or explorer API keys.
