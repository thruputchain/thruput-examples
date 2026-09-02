# Game of Life Local Workflow

Date: 2026-09-01

## Summary

Align Game of Life with the local-development workflow used by Swap and Token Launchpad:

1. Start a disposable local node outside the application.
2. Export `GROUNDHOG_CLI` and `GROUNDHOG_RUNTIME_MANIFEST`.
3. Run `npm --prefix apps/game-of-life run setup:local`.
4. Run `npm --prefix apps/game-of-life run dev`.

Game of Life differs from the other applications because it requires an indexer. Its `dev` command will therefore supervise both the indexer and Vite. It will not start, stop, or mutate the caller-owned Groundhog node.

The refactor will also update Game of Life for the DevWallet implementation bundled with `hog-devnode 0.1.26`.

## Motivation

Game of Life currently hides node startup, contract provisioning, indexer startup, and frontend startup behind `dev:local`. That command delegates to the clean-ledger acceptance harness, which combines normal development with browser testing, restart verification, evidence collection, and infrastructure cleanup.

Swap and Token Launchpad use clearer boundaries:

- The developer owns the local node.
- `setup:local` provisions the application on that node and writes `.env.local`.
- `dev` starts the application.
- `test:e2e:local` creates a disposable node and composes the normal setup path for acceptance testing.

Game of Life should expose the same operator contract while retaining its stronger browser and indexer durability checks.

## Goals

- Make `setup:local` provision Game of Life against an externally started disposable node.
- Require only `GROUNDHOG_CLI` and `GROUNDHOG_RUNTIME_MANIFEST` for the standard fixed-port workflow.
- Allow `GROUNDHOG_RPC_URL` when the node does not use `http://127.0.0.1:9545`.
- Prefund and deploy through manifest-derived local accounts and `@groundhogchain/client`.
- Keep the proven Rust live harness as the full-world initialization and receipt oracle.
- Remove setup's dependency on a copied DevWallet artifact, a generated CLI key, and a generated CLI profile.
- Make `dev` start and supervise the Game of Life indexer and Vite.
- Keep the externally started node outside the `dev` process ownership boundary.
- Make `test:e2e:local` compose the normal setup and service paths.
- Preserve clean-ledger browser acceptance and durable indexer restart verification.
- Accept and verify the DevWallet implementation shipped with `hog-devnode 0.1.26`.
- Expose generated credentials only when serving the development application on a loopback address.

## Non-goals

- Make setup idempotent on a previously provisioned ledger.
- Support production or shared-network deployment.
- Change contract behavior, world layout, indexer schemas, or frontend behavior.
- Add automatic service restarts.
- Start or stop an externally owned Groundhog node from `dev`.
- Unify every internal provisioning implementation across all three applications.

## User Workflow

The standard workflow is:

```bash
# Start a fresh disposable node separately.

export GROUNDHOG_CLI=/path/to/groundhog
export GROUNDHOG_RUNTIME_MANIFEST=/path/to/runtime-manifest.json

# Required only when the node does not use the standard local RPC port.
export GROUNDHOG_RPC_URL=http://127.0.0.1:44501

npm --prefix apps/game-of-life run setup:local
npm --prefix apps/game-of-life run dev
```

`setup:local` is state-changing and assumes a fresh disposable ledger. A failed or repeated setup may leave partial deployments and must not be retried blindly against the same ledger.

## Command Responsibilities

### `setup:local`

`setup:local` will:

1. Validate the CLI path, runtime manifest, loopback RPC URL, runtime identity, DevWallet identity, and bootstrap accounts.
2. Build `game-of-life` with the configured Groundhog CLI.
3. Load the faucet and the first three local users from the runtime manifest.
4. Construct source-address wallet clients for the faucet and Alice.
5. Read and hash `target/groundhog/game_of_life.rv32a`.
6. Derive the deployment address from Alice, a random nonce, and the contract hash.
7. Calculate and transfer the required storage reserve to the derived deployment address.
8. Deploy the contract through the existing Alice DevWallet.
9. Initialize the complete 10,000 by 10,000 world with seed `0` and queue length `64` through the existing Rust live harness.
10. Verify the deployment address, initialization receipt, `WorldInitialized` event, world dimensions, generation, seed, queue length, population, and digest.
11. Fund Alice, Bob, and Carol for local interactions.
12. Run the existing caller-verification integration journey.
13. Atomically publish `.env.local` only after provisioning succeeds.

The setup path will not create CLI keys, create CLI wallets, write a CLI profile, copy `dev_wallet.rv32a`, or require `GROUNDHOG_CONTRACT_ARTIFACTS_DIR`.

### `dev`

`dev` will:

1. Read and validate the generated `.env.local` as data.
2. Build the release indexer before starting it.
3. Map the Vite configuration to the indexer's environment.
4. Start the indexer on the configured loopback origin.
5. Start Vite on the configured loopback origin.
6. Wait for Vite and the first complete index publication.
7. Report the app, indexer, and RPC URLs.
8. Forward termination signals to both child processes.
9. Stop the sibling and exit nonzero if either service exits unexpectedly.

The command will use durable ignored storage under the repository's `tmp/game-of-life-indexer` directory by default. Explicit `GAME_OF_LIFE_ARTIFACT_ROOT` and `GAME_OF_LIFE_INDEXER_DB` values will override those defaults.

The existing `dev:local` command will be removed. Its current behavior materially differs from the new external-node workflow and cannot be preserved as a meaningful compatibility alias.

### `test:e2e:local`

The clean-ledger acceptance harness will:

1. Start and own a disposable local node.
2. Capture its RPC URL and runtime-manifest path.
3. Invoke the normal `setup:local` path.
4. Start the normal service supervisor with isolated storage and randomly assigned ports.
5. Run the Playwright browser journey.
6. Stop the service supervisor.
7. Restart the indexer directly against the same database and artifacts.
8. Verify that the restarted indexer publishes output byte-for-byte identical to the pre-restart output and leaves the durable evidence unchanged.
9. Restore the previous `.env.local` and stop only processes owned by the harness.

The harness will retain its separate, executable-verified `hog-devnode` PID discovery and cleanup. Stopping the `groundhog node` wrapper is not sufficient evidence that the underlying node exited.

## Runtime Manifest Compatibility

`hog-devnode 0.1.26` changed the bundled `dev_wallet.rv32a`. The manifest's contract-XDR hash changed from:

```text
0xc57f839d14635aac9e7bd60327dd2280a68a4f891eff815cfc80461de3649b7d
```

to:

```text
0x2ce57271ea4453163dc83b78908f1cd2983cf12a9fbb4709004b7db0757825f2
```

The setup path will require schema version 2, kind `hogd-dev-runtime`, producer `hog-devnode` version `0.1.26`, Groundhog wire format 5.x, a nonempty producer commit, derivation scheme `groundhog-bootstrap-account-v1`, a faucet, and at least three local users. It will validate every storage-cost field as a nonnegative decimal integer and require the storage-model hash. It will verify the `0.1.26` DevWallet hash and compare the manifest's deploy, create-wallet, and do-action entrypoints with the SDK's generated `DevWallet` binding. Validation failures will identify the exact incompatible field instead of using one combined error.

The expected `doActionEntrypoint` remains:

```text
0xa0fff94c64fbaf3c
```

## Provisioning Design

### Accounts

Use `loadLocalDevAccount` to derive and verify:

- the faucet;
- Alice, `local_user` offset 0;
- Bob, `local_user` offset 1;
- Carol, `local_user` offset 2.

This removes the current dependence on manifest array ordering and CLI account aliases.

Create separate connected client instances before binding faucet and Alice wallet clients because `createWalletClient` decorates a client instance and does not support rebinding it.

Before the first mutation, setup will verify that the faucet can fund the derived contract reserve, Alice, Bob, Carol, and the faucet's own transaction costs. Alice must already have enough native HOG for deployment and full-world initialization transaction costs. Persona funding will preserve the current 1,000 HOG target per user through exact faucet transfers.

### Contract Deployment

Build a protocol `Contract::kRv32` value from `game_of_life.rv32a`, then use `hashContract` and `deriveContractAddress` with a single random deployment nonce.

Prefund the derived address before submitting deployment. Compute the world and deployment reserve in raw units with the existing formula:

```text
worldReserve =
    40,004 * baseDataItemCost
  + 25,001,024 * bytestringCostPerByte
  + 64 * rcqCostPerEntry
  + baseContractDeploymentCost
  + artifactBytes * contractDeploymentCostPerByte
```

Because native ERC20 transfers use raw token units, setup will round `worldReserve` up to the next whole HOG and convert the rounded amount to raw units. The derived address is new for each random nonce, so setup will treat its native balance item as absent and add `balanceCost` to the transfer. It will check the faucet's balance against the complete transfer and transaction requirements before the first ledger mutation, then verify the target reserve after transfer.

Submit `DevWallet.deploy` as the root invocation, attach the application contract, require `ExecResultOK`, decode the returned address, and compare it with the locally derived address.

### Initialization

Invoke `GameOfLife.initialize` through the existing Rust live harness and Alice's manifest-derived DevWallet with the currently exercised limits:

- target gas: `59,000,000,000`;
- outer gas: `60,000,000,000`;
- expiry: 1,000 blocks;
- timeout: 600 seconds;
- seed: `0`;
- maximum queue length: `64`.

The Rust harness distinguishes committed success, committed failure, invalid submission, expiry, and unresolved pending state. Every non-success diagnostic includes the transaction hash. Setup will not publish `.env.local` for any non-success outcome. An unresolved pending outcome will explicitly instruct the operator to inspect that transaction and start a fresh disposable node rather than rerun setup.

Successful initialization must verify:

- one `WorldInitialized` event;
- width and height of 10,000;
- generation 0;
- seed 0;
- queue length 64;
- population `49,999,272`;
- digest `0x85d72e50016badafcf3bc5c7040d42900b0417c3adc6721015aa1147d6733e05`.

### Environment Publication

Write `.env.local` with mode `0600` through a same-directory temporary file and atomic rename. Preserve the existing lock, symlink rejection, backup, fingerprint, and failure-restoration behavior.

The file will contain chain identity, contract identity, transaction limits, development personas, and the indexer origin. The indexer origin defaults to `http://127.0.0.1:8787` and may be overridden for acceptance testing through `GAME_OF_LIFE_INDEXER_URL`.

## Service Supervision

The service supervisor will start direct executables rather than npm or Cargo wrappers:

```text
supervisor
|- target/release/game-of-life-indexer
`- node_modules/.bin/vite
```

The supervisor and its direct children will remain in one caller-owned process group so terminal and acceptance-harness signals reach the complete service unit. The supervisor will also signal and await each direct child explicitly. It will require the configured ports to be available and fail rather than select different ports, probe both endpoints, and treat every unrequested child exit as a stack failure. Shutdown will send `SIGTERM`, wait for a grace period, then send `SIGKILL` when necessary.

`GAME_OF_LIFE_APP_URL` will select the Vite origin and default to `http://127.0.0.1:5173`. `GAME_OF_LIFE_INDEXER_URL` will select the indexer origin during setup and default to `http://127.0.0.1:8787`. The acceptance harness will override both origins, `GAME_OF_LIFE_ARTIFACT_ROOT`, and `GAME_OF_LIFE_INDEXER_DB`, then launch the same supervisor. Readiness means that both the Vite root and the configured world's `latest.json` return successful responses. The harness will intentionally stop and await the supervisor before restarting the indexer directly.

Indexer scope will be derived from the generated Vite values:

| Indexer variable | Source |
| --- | --- |
| `GROUNDHOG_RPC_URL` | `VITE_GROUNDHOG_RPC_URL` |
| `GROUNDHOG_NETWORK_ID` | `VITE_GROUNDHOG_NETWORK_ID` |
| `GROUNDHOG_CONTRACT_ADDRESS` | `VITE_GAME_OF_LIFE_CONTRACT_ADDRESS` |
| `GAME_OF_LIFE_INDEXER_LISTEN` | `VITE_GAME_OF_LIFE_INDEXER_URL` |
| `GAME_OF_LIFE_CORS_ORIGINS` | configured Vite origin |

The supervisor will parse `.env.local` with Node's dotenv parser. It will not source the file through a shell.

## Safety Requirements

- Accept only credential-free loopback RPC, indexer, and Vite origins.
- Reject symlinked generated environment paths.
- Keep development private keys out of builds and preview mode.
- Publish `.env.local` only after all provisioning checks succeed.
- Never stop an externally owned node from `dev`.
- Stop only processes owned by the supervisor or process groups created by the acceptance harness.
- Preserve manually changed `.env.local` files during failure cleanup.
- Treat a fresh disposable ledger as an explicit operator precondition. The runtime manifest's `chainState` only describes startup and cannot prove that setup has not already mutated the ledger.

## Implementation Workstreams

### 1. Provisioning

- Move deployment and initialization from `test-clean-ledger.sh` into the normal setup path.
- Replace CLI key, profile, wallet, transfer, and deployment operations with manifest-derived client operations.
- Replace CLI persona airdrops with transfers from the manifest-derived faucet client.
- Return the deployed contract address to environment generation.

### 2. Runtime Compatibility

- Update the accepted DevWallet contract hash for `hog-devnode 0.1.26`.
- Verify manifest entrypoints against the SDK binding.
- Split manifest validation errors into actionable messages.

### 3. Development Services

- Replace the current clean-ledger wrapper with an indexer/Vite supervisor.
- Make `dev` invoke that supervisor.
- Add configuration and process-lifecycle tests.

### 4. Acceptance Composition

- Remove the development mode from `test-clean-ledger.sh`.
- Invoke normal setup against the harness-owned node.
- Invoke the normal service supervisor with random ports and isolated storage.
- Preserve Playwright and durable indexer restart checks.

### 5. Documentation

- Document the external-node workflow and ownership model.
- Document non-idempotence and disposable-ledger requirements.
- Document persistent indexer storage and cleanup.
- Keep the clean-ledger acceptance command and evidence contract current.

## Verification

Static and unit verification:

```bash
npm --prefix apps/game-of-life run format:check
npm --prefix apps/game-of-life run typecheck
npm --prefix apps/game-of-life test
npm --prefix apps/game-of-life run build
bash -n apps/game-of-life/scripts/setup-local.sh
bash -n apps/game-of-life/scripts/test-clean-ledger.sh
node --check apps/game-of-life/scripts/dev-local.mjs
cargo test -p game-of-life-indexer --locked
```

Live acceptance:

```bash
npm --prefix apps/game-of-life run test:e2e:local
```

Manual workflow smoke test:

1. Start a fresh local node.
2. Export the CLI, manifest, and nondefault RPC URL when needed.
3. Run `setup:local`.
4. Run `dev`.
5. Confirm the indexer publishes and the app loads.
6. Submit and process a request.
7. Stop `dev` and confirm the node remains running.
8. Confirm no indexer or Vite descendants remain.

## Acceptance Criteria

- Game of Life uses the same external-node, setup, and run sequence as Swap and Token Launchpad.
- Standard setup needs no DevWallet artifact directory or generated CLI profile.
- Setup succeeds with the `hog-devnode 0.1.26` runtime manifest.
- Setup rejects incompatible DevWallet hashes or entrypoints with specific diagnostics.
- `dev` starts the indexer and Vite without starting or stopping a node.
- `dev` cleans up both owned services on signals and sibling failure.
- `test:e2e:local` invokes the normal setup and service paths.
- Browser acceptance and durable indexer restart verification continue to pass.
- Existing unit, type, formatting, build, contract-binding, and indexer tests pass.
