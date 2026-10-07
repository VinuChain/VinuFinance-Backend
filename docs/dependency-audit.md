# Dependency audit policy

CI audits the runtime dependency graph and the complete Hardhat/Foundry
toolchain separately. `scripts/audit_gate.js` rejects every critical or high
advisory, including a summary whose advisory records are incomplete. Lower
severities remain visible in the emitted report.

The current full-graph run reports nine low-severity `elliptic` findings and no
moderate, high, or critical findings. The registry has no patched `elliptic`
release for those paths. Counts must be refreshed from CI because registry
advisories can change independently of this repository.

## Approved high-severity exception

`braces` 3.0.3 (GHSA-vfj7-8cjw-p6xm, stack-exhaustion denial of service on deeply
nested patterns) is reached only through `solidity-coverage` (mocha/chokidar and
globby/fast-glob/micromatch). The registry has no patched release and
`solidity-coverage` 0.8.17 is the latest, so nothing can be bumped. The path is
dev-only coverage tooling that expands trusted globs, never user input, and is
absent from the production graph. `scripts/audit_gate.js` approves it only in
the full scope, only for paths under `solidity-coverage>`, and only while the
advisory still reports no patched version; a patched release or any other path
fails the gate again. Remove the entry once `solidity-coverage` ships a fixed
`braces`.

## Out-of-range security resolutions

Some upstream tools pin vulnerable versions too narrowly. Yarn resolutions pin
patched replacements, and the compile, test, coverage, deployment, compiler,
network, and reconciliation gates provide compatibility evidence. `yarn check
--integrity` verifies the installed lockfile; `--verify-tree` is intentionally
unsuitable because it rejects these audited overrides before compatibility
tests can run.

| Advisory path | Pinned replacement | Compatibility gate |
| --- | --- | --- |
| Mocha/Hardhat `serialize-javascript` | 7.1.1 | Hardhat tests and coverage |
| Hardhat `solc>tmp` | 0.2.7 | compile and compiler alignment |
| Hardhat `adm-zip` | 0.6.1 | compile and deployment rehearsal |
| Hardhat Verify `undici` | 6.28.1 | network registration check |
| Ethers provider `ws` | 8.21.3 | Hardhat and reconciler suites |

The lockfile also pins patched `cookie`, `diff`, `uuid`, and affected `bn.js`
paths. Runtime code uses HTTP RPC and does not expose WebSocket, ZIP, or compiler
temporary-file inputs to users. Operators must still inspect the complete audit
report whenever a dependency or advisory changes.

For a reproducible local check:

```bash
yarn install --frozen-lockfile
yarn check --integrity
node --test scripts/audit_gate.test.js
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
