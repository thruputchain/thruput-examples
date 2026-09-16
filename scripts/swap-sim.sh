#!/bin/bash

# Requires the groundhog CLI in PATH, and a hog-devnode from the same client
# release for it to drive.  One beside the CLI is used by default; set
# GROUNDHOG_DEVNODE_BINARY to choose another.  See `resolve-devnode.sh`.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

devnode="$("$script_dir/resolve-devnode.sh")"
export GROUNDHOG_DEVNODE_BINARY="$devnode"

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
artifact_root="$(realpath target/groundhog)"
export GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$artifact_root"

cargo test -p swap-router \
    --test testkit_sim \
    -- \
    --ignored --no-capture
