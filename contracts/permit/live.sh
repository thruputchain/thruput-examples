#!/bin/bash

# Run the permit flow on a live devnode: an owner's off-chain signature,
# relayed by someone else, moving that owner's tokens.
#
# Requires `thruput` (the CLI) on PATH and its devnode toolchain
# (`thruput toolchain install`). Set THRUPUT_DEVNODE_BINARY to use another
# hog-devnode.

set -euo pipefail
cd "$(dirname "$0")/../.." # the repository root

# Build guest binaries for use below
build() {
    thruput build -p erc20
    thruput build -p permit-wallet
    thruput build -p permit-relayer
}

if [ ! -v NO_BUILD ]; then
    build
fi

export THRUPUT_DEVNODE_BINARY="${THRUPUT_DEVNODE_BINARY:-$(thruput toolchain which)}"
# export RUST_LOG="thruput_node_supervisor=info,hogd_dev=info"
export THRUPUT_TESTKIT_ARTIFACT_ROOT="$(realpath target/thruput)"

cargo test -p permit-wallet \
    --test testkit_permit \
    -- \
    --ignored --no-capture
