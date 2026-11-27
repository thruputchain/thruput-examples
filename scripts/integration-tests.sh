#!/bin/bash

# Run integration (RPC-targeted) tests: ERC20's RPC tests, and Counter's live
# Testkit test.
#
# Requires thruput-cli 0.48.0 or newer and a compatible hog-devnode. Counter's
# test runs Testkit 0.48.0, so it needs CLI 0.48.0 exactly.

set -euo pipefail

itest_contracts=(erc20)

for pkg in "${itest_contracts[@]}"; do
    echo "::group::thruput test --integration -p $pkg"
    # Tests share one funded signing account and mutable native-token reserves.
    thruput test --integration -p "$pkg" -- --test-threads=1 || {
        printf "Integration test failed for contract %s\n" "$pkg"
        exit 1
    }
    echo "::endgroup::"
done

# Counter's live test is a Testkit test, not a `thruput test --integration` one.
echo "::group::contracts/counter-live/run.sh"
bash "$(dirname "$0")/../contracts/counter-live/run.sh"
echo "::endgroup::"
