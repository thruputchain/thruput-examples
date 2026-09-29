#!/bin/bash

set -euo pipefail

cargo() {
    if [ -n "${CARGO_UNLOCK:-}" -o "$1" == "fmt" ]; then
        command cargo "$@"
    else
        command cargo --locked "$@"
    fi
}

set -x

# Build native tests
RUSTFLAGS="-D warnings" \
    cargo test --all --no-run

# Build all guest binaries
./scripts/build-guest.sh

# Run native tests
cargo test --all

# Run `test_r32` tests
for p in erc20 counter sep41-token; do
    groundhog test -p "$p"
done

# Run tests for contracts implementing the `guest_test` feature
for p in swap-driver swap-router swap-factory; do
    cargo test -p "$p" -F guest_test
done

# Run integration tests
./scripts/integration-tests.sh

# Quality checks
cargo clippy --workspace --all-targets --no-deps -- -D warnings
cargo fmt --check

grep -q '\[patch' Cargo.toml && {
    echo "Cargo.toml has patched dependencies!"
    exit 1
}

printf "\nContract checks passed.\n"
