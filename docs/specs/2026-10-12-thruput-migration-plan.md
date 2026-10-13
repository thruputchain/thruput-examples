# Thruput package and repository migration

## Implemented scope

Counter, Swap, and Token Launchpad use the published
`@thruputchain/client@0.18.0`, `@thruputchain/react@0.5.0` where needed, and
protocol, XDR, and contract-spec `0.15.0`. CLI `0.29.0` generates the bindings
and manages hog-devnode `0.1.31-rc.3` for live app checks.

The Rust workspace uses SDK `0.51.0`, interface crates `0.1.55`, protocol
crates `0.54.0`, and CLI/RPC/testkit `0.29.0`. Rebuilt contracts pass seeding
and batching against rc.3. The older SDK-built contracts failed token creation
on that runtime, so existing local deployments need fresh setup.

Sources now live in `thruputchain/thruput-sdk-ts`,
`thruputchain/thruput-protocol-ts`, and `thruputchain/thruput-examples`.

Application configuration uses `THRUPUT_*` and `VITE_THRUPUT_*`, the browser
proxy is `/thruput-rpc`, and SDK integration folders are `src/thruput/`.
SDK factories, types, and error symbols use the new Thruput names. Saved app
workflow keys and wire identifiers keep their existing names for compatibility.
The SDK still ships `groundhog-rv32.ld`, so the linker filename is unchanged.

The migration also fixed initial-mint event verification, local token storage
funding, and decimal-string event-height validation in the Swap proxy. The
original decimal-string airdrop failure came from stale client `0.10.0` files
in `node_modules`; the SDK fix was already published in client `0.17.0`.

Browser transactions use [Thruput Freighter](https://github.com/thruputchain/freighter).
App-side provider discovery, approval handling, and transaction recovery remain
part of the examples. Freighter browser approval flows need separate acceptance
testing.

The historical `tests/token-factory-ts` harness retains its separately pinned
CLI, runtime, and artifact hashes. Its modernization is separate work.

## Validation

The migration passed workspace type checks, unit tests, production builds,
browser fixtures, native Rust tests, guest contract builds and tests, Clippy,
RPC integration tests, seeding, atomic batching, and live Counter tests.

Current commands:

- `npm run typecheck`
- `npm test`
- `npm run build --workspaces`
- `npm run test:browser`
- `npm run test:counter`
- `npm run test:seed`
- `npm run test:batching`
- `cargo test --workspace --locked`
- `cargo clippy --workspace --all-targets --no-deps --locked -- -D warnings`
- `cargo fmt --check`

Live checks require rebuilt contracts, a matching CLI/runtime pair, and fresh
disposable nodes. See the root README for setup instructions.

## Remaining external checks

Verify package Actions access, CI secrets, and runner access for the moved
repository.

Dependency policy reports RUSTSEC-2024-0449 for `unsafe-libyaml` through
`thruput-xdr-macros@0.54.0`. The same YAML dependency exists on the original
main branch through `groundhog-xdr-macros@0.51.0`. This is a pre-existing
maintenance advisory; no policy exception has been added.
