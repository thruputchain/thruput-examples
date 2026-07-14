#!/bin/bash

set -eux

./scripts/build.sh

RUSTFLAGS="-D warnings" \
    cargo test --all

# ./scripts/integration-tests.sh

# Quality checks
cargo clippy --workspace --all-targets --no-deps -- -D warnings
cargo fmt --check

grep -q '\[patch' Cargo.toml && {
    echo "Cargo.toml has patched dependencies!"
    exit 1
}

printf "\nCI OKAY!\n"
