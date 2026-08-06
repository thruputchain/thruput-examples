#!/bin/bash

# Requires `groundhog` (the cli) in PATH and an environment var:
#   GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode

set -euo pipefail

# Build guest binaries for use below
build() {
    groundhog build -p erc20 -- -F metadata
    groundhog build -p swap-pair --target "wasm" # doesn't fit in rv32a yet
    groundhog build -p swap-driver
    groundhog build -p swap-router
    groundhog build -p swap-handler
}

build

# export RUST_LOG="groundhog_node_supervisor=info,hogd_dev=info"
export HOGD_PROTOCOL_OVERRIDE="hogp/70780a9cf74d"  # for hog-devnode from groundhog-client v0.1.18
export GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$(realpath target/groundhog)"

cargo test -p swap-router \
    --test testkit_sim \
    -- \
    --ignored --no-capture
