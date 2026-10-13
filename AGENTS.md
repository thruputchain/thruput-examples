# Repository guide for coding agents

## Purpose and layout

This is a teaching repository. Prefer small, explicit examples that use the
published SDK. Keep the operation being taught visible; do not add a framework
to remove a few repeated lines. Larger apps are reference implementations.

- `contracts/`: Rust examples. Start with Counter, Fibonacci, and Events.
- `examples/typescript/`: small runnable client scripts using published packages.
- `apps/`: Counter (concurrent transaction demo), Launchpad, and Swap.
- `apps/*/scripts/`: app setup and generation entrypoints.
- `scripts/seed/`: shared app-seeding implementation, not a beginner example.
- `scripts/`: repository checks and advanced tools; read `scripts/README.md`.
- `interfaces/`, `helpers/`, `engines/`: supporting Rust code.
- `sim-fixtures/`: simulator workloads, not teaching examples.

## Setup

Follow `docs/getting-started.md`. Use npm and the root `package-lock.json`.
Node must be at least 22.13. Rust is pinned in `rust-toolchain.toml`.
Use CLI 0.29.0 and its managed runtime 0.1.31-rc.3 with this release set.

Cargo needs `thruput` registry access and a credential provider such as
`cargo:token`. npm needs GitHub Packages authentication for `@thruputchain/*`.
Keep credentials in the user's config/environment. Never commit tokens or keys.

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

For an app, also set `THRUPUT_CLI` to the CLI executable and
`THRUPUT_RUNTIME_MANIFEST` to the path printed by that node:

```sh
npm run setup:local --workspace apps/counter
npm run dev --workspace apps/counter
```

Counter runs on 5175, Launchpad on 5173, and Swap on 5174. Read the selected app
README before setup. Freighter is maintained separately.

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
Counter artifact/binding. More live/guest commands are in `docs/development.md`.
Report tests actually run and separate environment failures from passing checks.

## Scope and documentation

Root/app READMEs and `docs/getting-started.md` are current usage guides.
`docs/specs/` and `docs/superpowers/` are historical records, not standing
instructions to implement their plans. `REPOSITORY_REVIEW.md` records deferred
discussion topics. `tests/token-factory-ts` is a historical harness outside
the active npm workspace; do not use its pins for new examples.

Keep changes scoped. Avoid shared app frameworks, speculative abstractions, or
rewriting transaction recovery during documentation work. Commit or push only
when requested.
