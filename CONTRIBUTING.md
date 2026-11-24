# Contributing

This repository teaches developers how to build on Thruput. Keep each example
small, and keep the Thruput calls easy to find. Read [AGENTS.md](AGENTS.md) for
the repository rules, and [scripts/README.md](scripts/README.md) for the layout
and all checks.

## Checks

Run focused checks first:

```sh
cargo test -p counter --locked --test test
npm run typecheck
npm test
npm run build --workspaces
cargo fmt --check
cargo clippy --workspace --all-targets --no-deps --locked -- -D warnings
```

Live end-to-end checks are listed in [scripts/README.md](scripts/README.md#checks).

## Update dependencies

New crate and npm releases must be older than a cooldown period before a
lockfile takes them. First-party packages (`thruput`, `thruput-*`, and
`@thruputchain/*`) are exempt. Dependabot opens weekly update pull requests
under this cooldown.

- **Rust.** Update `Cargo.lock` with
  [cargo-cooldown](https://crates.io/crates/cargo-cooldown)
  (`cargo cooldown update`), not `cargo update`. CI checks the lockfile with
  [cargo-cooldown-check](https://github.com/NomicFoundation/cargo-cooldown-check).
  The policy is in `cooldown.toml`, `.cargo/cooldown.toml`, and
  `.cargo/cooldown-allowlist.toml`. Keep these files in sync.
- **npm.** `.npmrc` sets `min-release-age`, which recent npm releases (such as
  npm 12) apply when they resolve new versions.
