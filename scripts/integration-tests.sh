#!/bin/bash

# Run integration (RPC-targeted) tests.
#
# Requires the groundhog-cli and devnode.

set -euo pipefail

target="${TARGET:-rv32}"
itest_contracts=(counter erc20)

for pkg in "${itest_contracts[@]}"; do
    echo "::group::groundhog test --integration -p $pkg"
    groundhog test --target "$target" --integration -p "$pkg" || {
        printf "Integration test failed for contract %s\n" "$pkg"
        exit 1
    }
    echo "::endgroup::"
done
