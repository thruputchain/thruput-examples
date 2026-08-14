#!/bin/bash

set -xeuo pipefail

swap_contracts=(swap-pair swap-handler swap-driver swap-factory swap-router)
swap_packages=(swap_if "${swap_contracts[@]}")

# Build native tests
for p in "${swap_contracts[@]}"; do
    RUSTFLAGS="-D warnings" \
        cargo test -p "$p" --no-run
done

# Run native tests
for p in "${swap_contracts[@]}"; do
    RUSTFLAGS="-D warnings" \
        cargo test -p "$p"
done

# Test with guest binaries
./scripts/swap-test-guest.sh

# RPC test
GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$(realpath target/groundhog)" \
    cargo test -p swap-router \
        --test testkit_sim \
        -- \
        --ignored \
        --no-capture \
    ;
