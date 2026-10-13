#!/bin/bash

# Run integration (RPC-targeted) tests.
#
# Requires thruput-cli 0.29.0 or newer and a compatible hog-devnode.

set -euo pipefail

itest_contracts=(counter erc20)

for pkg in "${itest_contracts[@]}"; do
    echo "::group::thruput test --integration -p $pkg"
    # Tests share one funded signing account and mutable native-token reserves.
    thruput test --integration -p "$pkg" -- --test-threads=1 || {
        printf "Integration test failed for contract %s\n" "$pkg"
        exit 1
    }
    echo "::endgroup::"
done
