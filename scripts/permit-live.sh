#!/bin/bash

# Run the permit flow on a live devnode: an owner's off-chain signature,
# relayed by someone else, moving that owner's tokens.
#
# Requires `thruput` (the cli) in PATH and an environment var:
#   THRUPUT_DEVNODE_BINARY=/path/to/hog-devnode

set -euo pipefail

# Build guest binaries for use below
build() {
    thruput build -p erc20
    thruput build -p permit-wallet
    thruput build -p permit-relayer
}

if [ ! -v NO_BUILD ]; then
    build
fi

# export RUST_LOG="thruput_node_supervisor=info,hogd_dev=info"
export THRUPUT_TESTKIT_ARTIFACT_ROOT="$(realpath target/thruput)"

cargo test -p permit-wallet \
    --test testkit_permit \
    -- \
    --ignored --no-capture
