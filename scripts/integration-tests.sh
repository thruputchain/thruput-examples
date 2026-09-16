#!/bin/bash

# Run integration (RPC-targeted) tests.
#
# Requires the groundhog CLI on PATH, and a hog-devnode from the same client
# release for it to drive -- see `resolve-devnode.sh`.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

devnode="$("$script_dir/resolve-devnode.sh")"
export GROUNDHOG_DEVNODE_BINARY="$devnode"

itest_contracts=(counter erc20)

for pkg in "${itest_contracts[@]}"; do
    echo "::group::groundhog test --integration -p $pkg"
    groundhog test --integration -p "$pkg" || {
        printf "Integration test failed for contract %s\n" "$pkg"
        exit 1
    }
    echo "::endgroup::"
done
