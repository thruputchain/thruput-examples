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

RUSTFLAGS="-D warnings" \
    cargo test --all

./scripts/build-guest.sh
for p in swap-driver swap-router; do
    cargo test -p "$p" -F guest_test
done

# ./scripts/integration-tests.sh

# Quality checks
cargo clippy --workspace --all-targets --no-deps -- -D warnings
cargo fmt --check

grep -q '\[patch' Cargo.toml && {
    echo "Cargo.toml has patched dependencies!"
    exit 1
}

printf "\nCI OKAY!\n"
