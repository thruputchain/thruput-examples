# Repository guide for coding agents

## Purpose and layout

This is a teaching repository. Prefer small, explicit examples that use the
published SDK. Keep the operation being taught visible; do not add a framework
to remove a few repeated lines. The apps are teaching references, not
production services: do not add hardening that hides the Thruput calls.

- `contracts/`: Rust examples. Start with Counter, Fibonacci, and Events.
  `contracts/README.md` is the index. A folder is one example crate, or a
  project folder of related crates (`swap/`, `token-factory/`, `permit/`,
  `stellar-account/`, `waitlist/`) with its own README. Benchmarks and live
  scripts live in their project, not in `scripts/`. Each example is a separate
  crate that teaches one thing; remove overlap rather than merge crates.
- `examples/typescript/`: small runnable client scripts using published packages.
- `apps/`: Counter, Voting, Airdrop, Token Launchpad, and Swap. Voting is the
  reference for the wallet transaction pattern; Launchpad and Swap copy it in
  `src/transactions/use-wallet-transaction.ts` and `saved-record.ts`. All four
  wallet apps copy `saved-outcome.ts`. Keep those copies identical.
- `apps/*/scripts/`: app setup and generation entrypoints.
- `scripts/seed/`: shared app-seeding implementation, not a beginner example.
- `scripts/`: repository-wide builds and checks; read `scripts/README.md`.

## Setup

Follow the root README's Setup section. Use npm and the root `package-lock.json`.
Node must be at least 22.13. Rust is pinned in `rust-toolchain.toml`.
Use CLI 0.48.0 or newer and let it select its compatible managed runtime.
The Rust crates and `contracts/counter-live` still pin 0.47.0.

Rust crates come from crates.io and `@thruputchain/*` packages from the public
npm registry; neither needs credentials. Never commit tokens or keys.

Dependency updates follow a cooldown policy; see
[Update dependencies](CONTRIBUTING.md#update-dependencies). Use
`cargo cooldown update`, not `cargo update`, and keep the cooldown files in
sync with each other.

Run commands from the repo root. Native tests need no node or browser:

```sh
cargo test -p counter --locked --test test
cargo test -p fibonacci --locked
```

For client examples, run `npm ci`, start `thruput node --port 9545 --json` in a
separate terminal, then:

```sh
export THRUPUT_RPC_URL=http://127.0.0.1:9545
npm run example:chain-tip
npm run examples:generate
npm run example:deploy-counter
```

App setup uses `thruput` on `PATH` and discovers the network through the SDK.
`THRUPUT_CLI` selects another executable; `THRUPUT_NETWORK_ID` and
`THRUPUT_RUNTIME_MANIFEST` are optional network checks:

```sh
npm run setup:local --workspace apps/counter
npm run dev --workspace apps/counter
```

Counter runs on 5175, Launchpad on 5173, Swap on 5174, Voting on 5176, and
Airdrop on 5177. Read the selected app README before setup. Freighter is
maintained separately.

## State and generated files

- Setup creates fresh deployments and writes app environments/public artifacts.
  It is not a read-only validation command. Preserve user deployments and state.
- `.env.local`, `.env.devnet`, `.local/`, and runtime manifests may identify active
  deployments or contain signer material. Do not delete or print private values.
- Client signing examples use disposable local accounts; they do not save keys.
- Never hand-edit `apps/*/src/contracts/generated/` or
  `examples/typescript/generated/`. Run the corresponding generation command.
- Rebuilt artifacts and regenerated bindings must be used together.
- Preserve transaction evidence and account/network checks. Do not turn an
  uncertain submission into permission to send another transaction.

## Verification

Run focused checks first. Root `npm run typecheck` covers apps, shared seeding,
and the TypeScript examples. Root `npm test` covers app/seed tests and process
cleanup. It does not run a node.

```sh
npm run typecheck
npm test
npm run build --workspaces
cargo fmt --check
cargo clippy --workspace --all-targets --no-deps --locked -- -D warnings
```

`npm run test:browser` needs Chromium. `npm run test:examples` starts an isolated
node and runs the client scripts; set `THRUPUT_CLI` and
`THRUPUT_DEVNODE_BINARY="$(thruput toolchain which)"` first and generate the
Counter artifact/binding. More live/guest commands are in `scripts/README.md`.
Report tests actually run and separate environment failures from passing checks.

## Scope and documentation

Use root, example, app, and script READMEs as the current usage guides.
Keep explanations close to the code; do not accumulate historical plans or
duplicate guides. Seeding creates fresh local assets on every invocation,
requires `SEED_RECIPIENT`, and never saves a key or retries an uncertain write.

Keep changes scoped. Avoid shared app frameworks, speculative abstractions, or
rewriting transaction recovery during documentation work. Commit or push only
when requested.
