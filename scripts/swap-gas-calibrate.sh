#!/bin/bash

# Measure what a crank actually costs on a devnode, to set the gas constants
# from.
#
# This builds the drivers with `calibration`, which makes a crank report its own
# spending as a `GasReport` event (and an ordering driver's choosing as a
# `PickReport`), runs requests through a local node, and prints what it charged:
#
# - one request of each kind through `swap-driver`, for the per-request budgets;
# - batches of swaps through each of `swap-driver`, `swap-gsr-driver` and
#   `swap-clvr-driver`, for the ordering drivers' allowances;
# - CLVR's ordering alone, over batches up to a full queue, with `clvr-bench`.
#
# The artifacts it builds are instrumented: rebuild without `calibration`
# before using them for anything else.

set -euo pipefail

if [ ! -v NO_BUILD ]; then
    thruput build -p erc20 -- -F metadata
    thruput build -p swap-handler
    thruput build -p swap-router
    thruput build -p swap-factory
    # The instrumented ones.
    thruput build -p swap-driver -- -F calibration
    thruput build -p swap-gsr-driver -- -F calibration
    thruput build -p swap-clvr-driver -- -F calibration
    thruput build -p clvr-bench
fi

artifact_root="$(realpath target/thruput)"
export THRUPUT_TESTKIT_ARTIFACT_ROOT="$artifact_root"

for test in calibrate_crank_gas calibrate_ordered_crank_gas measure_clvr_ordering; do
    cargo test -p swap-router \
        --features calibration \
        --test calibration "$test" \
        -- \
        --ignored --no-capture --exact
done
