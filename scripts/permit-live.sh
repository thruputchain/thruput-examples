#!/bin/bash

# Run the permit flow on a live devnode: an owner's off-chain signature,
# relayed by someone else, moving that owner's tokens.
#
# Requires `groundhog` (the cli) in PATH and an environment var:
#   GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode

set -euo pipefail

# Build guest binaries for use below
build() {
    groundhog build -p erc20
    groundhog build -p permit-wallet
    groundhog build -p permit-relayer
}

if [ ! -v NO_BUILD ]; then
    build
fi

# export RUST_LOG="groundhog_node_supervisor=info,hogd_dev=info"
export GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$(realpath target/groundhog)"

cargo test -p permit-wallet \
    --test testkit_permit \
    -- \
    --ignored --no-capture
