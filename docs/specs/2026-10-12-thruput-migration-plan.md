# Thruput package and repository migration

## Current implementation scope

The package-scope migration below is deferred until the upstream releases are
published. The examples now use the published `@groundhogchain/client@0.17.0`
and React `0.4.0`, with the client's matching protocol family at `0.13.0`.
The decimal-string fix was already released in client `0.17.0` on October 9;
the local failure came from stale client `0.10.0` files in `node_modules`.
A clean `npm ci` resolved that mismatch.

The current changes rename application configuration to `THRUPUT_*` and
`VITE_THRUPUT_*`, the browser proxy to `/thruput-rpc`, SDK integration folders to
`src/thruput/`, and app package names and visible copy. Existing wallet vaults,
workflow keys, SDK symbols, and wire identifiers retain their current names.
The historical `tests/token-factory-ts` harness retains its separately pinned
CLI, runtime, and artifact hashes; its modernization remains separate work.

Live checks also identified and fixed initial-mint event verification, insufficient
local token storage headroom, and numeric-only event-height validation in the
Swap proxy. The real wallet journey passes all 20 local/production checks.

## Goal

Upgrade the examples to the published `@thruputchain/*` packages, support the current node's decimal-string RPC responses, and complete the Groundhog-to-Thruput rebrand across this repository.

Deliver the migration in reviewable stages. Start with a verified dependency and toolchain set, then update consumers, persistent state, Rust integration, and documentation. A global text replacement alone would break several runtime interfaces.

## Review findings

- The root npm workspace contains Counter, Swap, and Token Launchpad. It currently pins client `0.17.0`, protocol/XDR/contract-spec `0.13.0` where used, and React integration `0.4.0` in Swap and Launchpad.
- The wallet extension has a separate install and lockfile. `tests/token-factory-ts` is another separate install, with much older client `0.4.0` and protocol-family `0.8.0` dependencies. Root workspace commands do not cover these packages.
- The local node returns `retryAfterSeconds: "1"`. The installed client requires a number. Setup reaches the airdrop request, then fails before factory deployment.
- Registry configuration still targets `@groundhogchain` at GitHub Packages. The root and several app `.npmrc` files need review, along with CI install scopes.
- Application source uses old SDK symbols, `src/groundhog/` directories, `GROUNDHOG_*` and `VITE_GROUNDHOG_*` configuration, and `/groundhog-rpc` proxy routes.
- Server proxy allowlists and browser fixtures name `groundhog_*` RPC methods. Provider discovery uses `groundhog:announceProvider` and `groundhog:requestProvider`; the extension has its own old message channels and provider ID.
- Saved workflow keys, write locks, and session keys use the old name. The encrypted wallet vault uses `groundhog-wallet:vault:1` as AES-GCM authenticated data. Changing that string without migration makes existing vaults fail to decrypt.
- Rust dependencies include many `groundhog-*` crates. The workspace pins SDK `0.49.0`, CLI/RPC/testkit `0.27.0`, and protocol crates `0.51.0`. The linker configuration names `groundhog-rv32.ld`.
- CI references the old GitHub organization, a `GROUNDHOG_REGISTRY_TOKEN` secret, an old repository identity, and an existing release bucket. These are external resources, not just labels.

### Package verification is still open

During this review, `npm view @thruputchain/client` returned 404 from both GitHub Packages and npmjs. The GitHub CLI also returned 403 when listing organization packages because its token lacks `read:packages`. The sibling local client checkout still describes the old package.

This does not establish that the new packages are unpublished. Confirm the intended registry, available access, and exact release versions before changing dependencies. The new SDK exports, RPC names, and decimal-string decoding have not yet been verified.

## 1. Establish the supported release set

1. Resolve package access and record exact versions for `@thruputchain/client`, `protocol`, `xdr`, `contract-spec`, and `react`.
2. Inspect their exports, peer dependencies, migration notes, and published code. Confirm the renamed client, provider, React, wallet, and error APIs.
3. Confirm that the client parses decimal-string airdrop responses and polls pending requests correctly. Check other changed integer fields, including event sequence numbers, heights, gas values, and receipt fields. Distinguish raw RPC strings from the SDK's decoded application types.
4. Identify the compatible CLI/code generator, runtime, Rust SDK, and crate releases. Verify the RPC and provider-discovery names each release actually uses.
5. Record this version matrix in the setup documentation and use exact dependency pins, as the repository does today.

**Exit condition:** package metadata is accessible, and the selected release set supports the running node's response format.

## 2. Upgrade TypeScript packages and generated bindings

1. Update dependencies and package names in the root, all three apps, the wallet extension, and the standalone token-factory tests.
2. Set the new registry scope in each relevant `.npmrc` and CI install step. Keep authentication outside committed configuration. Confirm install access in both local development and CI.
3. Regenerate all three npm lockfiles with npm. Check for unwanted duplicate SDK versions or remaining old packages in the resolved graph.
4. Update imports and SDK symbols to the published APIs. Cover shared seed scripts, browser fixtures, transaction execution/recovery, registry indexing, and extension code.
5. Align the CLI version checks and CI pins with the chosen generator. Regenerate contract bindings from the contract specs; do not hand-edit generated imports.
6. Update numeric conversions only where the new SDK's public types require them. Keep amounts and wide integers exact; do not convert arbitrary decimal strings through JavaScript `Number`.

**Exit condition:** each npm project installs cleanly and passes its type checks. Regenerated bindings import the new packages, and regeneration produces no unexplained differences.

## 3. Rename application configuration and runtime interfaces

1. Rename `src/groundhog/` directories and repository-owned symbols to `thruput`/`Thruput`. Update imports, mocks, and documentation together.
2. Rename configuration to `THRUPUT_*` and `VITE_THRUPUT_*`. Update setup output, environment examples, server parsers, deployment configuration, scripts, and test fixtures. Account for ignored local/devnet environment files during the local rollout.
3. Rename the app-owned proxy route to `/thruput-rpc` across browsers, servers, and tests.
4. Match proxy RPC allowlists and request validators to the selected SDK/node methods. Keep the existing write policy for each app. A package-scope rename is not proof that the wire method names changed.
5. Align wallet discovery, provider types, and extension messaging with the new SDK. Update the extension and apps together, including provider IDs, origin permissions, and browser tests.
6. Update user-facing names, errors, page titles, package metadata, and extension metadata.

**Exit condition:** all apps connect through the new configuration and route, discover the wallet, and use the correct wire methods.

## 4. Migrate existing local state

Recommended default: preserve existing wallets and transaction evidence.

1. Introduce a versioned Thruput vault envelope. Read the old version using its original authenticated-data value; write the new version with the new value. Migrate after successful unlock and preserve the old stored envelope until the replacement is safely saved. Keep account derivation and addresses stable.
2. Migrate workflow and session keys without losing signed transaction evidence or resubmitting transactions. Preserve network/account scope checks and handle conflicting old/new records explicitly.
3. Treat cross-tab lock names as a coordination change. Coordinate the app reload and extension update so old and new tabs cannot acquire independent locks for the same account.
4. Review provider permissions, seed journals, and registry scope data for identifiers affected by the rename. Preserve existing addresses, network hashes, and database contents unless an explicit deployment change requires new state.
5. Add focused tests for old-vault unlock, migrated workflow recovery, and lock behavior. Isolate required legacy literals in migration code and fixtures.

**Decision for review:** if all existing state is disposable, we can choose a documented reset instead. That reduces migration work but requires recreating/importing wallets and explicitly resolving or abandoning saved workflows. Do not assume this from the fact that the apps are examples.

## 5. Complete Rust, CI, and documentation changes

1. Verify and adopt published `thruput-*` crate names and compatible versions. Update workspace and member manifests, Rust imports, helpers, testkit usage, and the Cargo lockfile together.
2. Use the linker script supplied by the selected SDK. Update `.cargo/config.toml` and the contract overlay only after confirming the new file name and build behavior.
3. Review hashed protocol inputs, domain separators, and serialized identifiers before renaming literals. A brand edit must not silently change signature verification, account addresses, or contract behavior.
4. Rebuild contracts and verify generated specs, bindings, code hashes, and public artifact files as a matched set. Fresh local deployments can use rebuilt code; recorded Devnet addresses must remain paired with their actual deployed code and artifacts.
5. Update GitHub organization/repository links and reusable workflows after confirming their destinations. Coordinate renamed CI secrets and release storage with the actual infrastructure. Do not invent a replacement bucket or secret name that has not been provisioned.
6. Update root/app READMEs, historical specs, script examples, and old-named document paths. Repair internal links and preserve accurate historical deployment facts.
7. Audit tracked content and file paths case-insensitively for `groundhog`. Document any remaining compatibility or external-resource literals with their reason and removal condition. Exclude dependency/build output from manual edits.

**Exit condition:** repository-owned branding is Thruput throughout; any remaining old literals have a verified technical reason.

## 6. Validate and qualify the migration

### Automated checks

- Root: `npm run typecheck`, `npm test`, `npm run build --workspaces`, and `npm run test:browser`.
- Wallet extension: its separate install, typecheck, unit tests, build, and browser acceptance checks.
- Standalone token-factory tests: separate install, code generation, typecheck, and live tests with their required node environment.
- Live app checks: `npm run test:counter`, `npm run test:seed`, `npm run test:batching`, and `npm run test:wallet` using fresh disposable nodes and the selected toolchain.
- Rust: the existing CI checks, including locked native tests, guest builds, RPC integration tests, guest tests, and CLI version-check tests. Run the repository's existing workflow lint and dependency policy checks.
- Focused regressions: pending airdrop with decimal-string delay, correct polling completion, current event/receipt numeric formats, proxy allowlists, provider discovery, and persistent-state migration.

### Local acceptance

1. Run Launchpad setup against a compatible local node and its matching runtime manifest. Confirm airdrop completion, factory deployment, and generated environment/artifact pairing.
2. Start Launchpad, unlock the updated wallet, request test funds, connect, and create a token. Verify the registry indexes it and displays its balance.
3. Run Launchpad and Swap seeding on an isolated test deployment. Verify pool creation, liquidity, and a swap through the wallet.
4. Reload the apps and extension. Verify account identity, pending-workflow recovery, and absence of duplicate submissions.
5. Confirm a clean install/build works from lockfiles and that setup regeneration does not restore old package imports.

## Suggested change groups

1. Published package/toolchain upgrade and binding regeneration.
2. Application, configuration, proxy, and wallet-interface rebrand.
3. Persistent-state migration and regression coverage.
4. Rust/package integration, CI resources, and documentation cleanup.

Keep related consumers together when an API change requires it. These are review boundaries, not a promise that each partial state can be deployed independently.

## Inputs needed before implementation

- Confirm the registry and release versions for the new packages, or restore package-read access so they can be discovered.
- Confirm the existing-state policy: preservation is recommended; an explicit reset is the simpler alternative for disposable examples.
- Confirm the new GitHub repository/workflow locations and whether CI secrets and release storage have already moved.

## Done when

Launchpad setup succeeds with the current decimal-string RPC format; all npm projects use the verified Thruput packages; app and extension flows pass; the chosen state policy is tested; Rust and CI checks pass; and the final old-name audit contains only documented compatibility or external-resource exceptions.
