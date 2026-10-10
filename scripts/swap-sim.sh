#!/bin/bash

# Requires the `thruput` CLI in PATH

set -euo pipefail

# Build guest binaries for use below
build() {
    thruput build -p erc20 -- -F metadata

    thruput build -p swap-driver
    thruput build -p swap-router
    thruput build -p swap-handler
    thruput build -p swap-factory
}

if [ ! -v NO_BUILD ]; then
    build
fi

# export RUST_LOG="groundhog_node_supervisor=info,hogd_dev=info"
export THRUPUT_TESTKIT_ARTIFACT_ROOT="$(realpath target/thruput)"

cargo test -p swap-router \
    --test sim_liquidity \
    -- \
    --ignored --no-capture
