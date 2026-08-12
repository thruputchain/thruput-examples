# Token Factory Phase 5 Evidence

Phase 5 evidence separates host invariants from release-grade native-HOG measurements. The machine-readable release-candidate record is `docs/releases/standard-token-factory-v1.json`.

## Completed Host Evidence

- `cargo test -p standard-token-factory --test storage`
  - Factory-created zero-supply token has a physical zero holder NNInt row.
  - The host fixture measures child-owned initialization state independently from deployment cost.
  - One below that host boundary fails at commit; the exact boundary succeeds.
  - The latest run measured both balance and allowance rows at `12,000` host storage tokens.
  - Cost-enabled creation preserves the configured logical HOG balance at the child address; the host API does not expose remaining free reserve directly.
  - New rows consume only their token's storage grant.
  - Existing balance and allowance rows remain usable after row-creation reserve is exhausted.
- `cargo test -p standard-token-factory --test top_up`
  - Mock ERC-20 top-up and token operations share one call tree.
  - Semantic transfer or allowance failure rolls the preceding mock top-up back.
  - This is atomicity evidence only. `TestEnvironment::no_cost()` does not prove native HOG enables storage allocation.
- `scripts/verify-standard-token-reproducibility.sh`
  - Builds the standard token, factory, and test wallet twice in isolated target directories with `--locked`.
  - Requires byte-identical RV32 artifacts and contract specs and matches them against the release manifest.
  - Records toolchain, base revision, reproducible source-tree hash, lockfile hash, artifact hashes, and artifact size.
  - Records whether relevant sources are dirty and hashes both their binary Git diff and a deterministic archive of untracked inputs so an uncommitted candidate is not mislabeled by `HEAD` alone.

## Release-Candidate Build

- RV32 artifact bytes: `30,124`
- RV32 artifact SHA-256: `8cc88befd6e6eddaad85761cfcdb442c866c0b967bd835ca980fec8bd7762daa`
- Network code hash: `f7ab4d2c0f21d0251441d7c0d8054c2ff6d0efb223547dbe99e0ffe9f0547503`
- Spec JSON SHA-256: `a6100fa440f6309b8f1277ae73b6d76b3cd3523a2b5fe144bc428cce08e921e1`
- Spec XDR SHA-256: `b41c5d5d996a6bf6b8e8f8e1781357ebb825e6ebd2359a475021bc1bc4c9bb9b`
- Rust: `1.98.0-nightly (f46ec5218 2026-06-30)`
- Cargo: `1.98.0-nightly (a335d47ff 2026-06-26)`
- Groundhog CLI: local `groundhog-rpc` build `0.9.1` at `/home/chambaz/Work/groundhog-rpc/target/debug/groundhog`
- The release manifest also records the factory and test-wallet artifact/spec hashes, lockfile and toolchain identities, CLI binary hash, runtime binary hash, and the absence of a canonical factory address at release-candidate stage.

Run the script again after every source, dependency, or toolchain change. Its output, not these sampled values, is the release-candidate record.

## Native-HOG Measurement

- Runtime: `hog-devnode 0.1.19` at commit `046159036753c9c92ed0b13d66c6ad1e6ea6ccf7`
- Protocol: `hogp/0cd3c454cdeb`
- Fresh-node launch inputs: `10` accounts, seed `groundhog-dev-accounts`, `1,000,000,000` storage tokens per account
- Cost-model hash: `7fcd5d27353800caf9f8f3a73a030be49a1dcd9db4616792e7887746bea713ce`
- Minimum source transfer to an empty prediction: `352,004`
- Native balance-item cost: `1,234`
- Published free-reserve threshold `required_token_funding`: `350,770`
- Conservative margin: `0`
- Free reserve after maximum-metadata, maximum-supply creation: `0`
- Balance-row cost: `12,000`
- Allowance-row cost: `12,000`

The ignored `testkit_sim` target starts a fresh node and proves source-transfer minimum minus one fails with `BoundsExceeded`, the exact minimum succeeds, the published factory view returns the free-reserve threshold, row-cost top-ups enable first balance and allowance rows, and failed token operations roll native-HOG top-ups back.

Re-run both the reproducibility script and devnode scenario whenever source, dependencies, CLI, runtime, or cost model changes.
