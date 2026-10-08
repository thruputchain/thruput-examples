#!/bin/bash

# Requires the `groundhog` CLI in PATH

set -euo pipefail

# Build guest binaries for use below
build() {
    groundhog build -p erc20 -- -F metadata

    groundhog build -p swap-driver
    groundhog build -p swap-router
    groundhog build -p swap-handler
    groundhog build -p swap-factory
}

if [ ! -v NO_BUILD ]; then
    build
fi

# export RUST_LOG="groundhog_node_supervisor=info,hogd_dev=info"
export GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$(realpath target/groundhog)"

cargo test -p swap-router \
    --test sim_liquidity \
    -- \
    --ignored --no-capture
