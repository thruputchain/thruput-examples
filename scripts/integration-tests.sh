#!/bin/bash

# Run integration (RPC-targeted) tests.
#
# Requires thruput-cli 0.27.0 or newer and a compatible hog-devnode.

set -euo pipefail

itest_contracts=(counter erc20)

for pkg in "${itest_contracts[@]}"; do
    echo "::group::thruput test --integration -p $pkg"
    thruput test --integration -p "$pkg" || {
        printf "Integration test failed for contract %s\n" "$pkg"
        exit 1
    }
    echo "::endgroup::"
done
