#!/bin/bash

# Measure what a crank actually costs on a devnode, to set the gas constants
# from.
#
# This builds the driver with `calibration`, which makes `crank` report its own
# spending as a `GasReport` event, runs one request of each kind through a local
# node, and prints what it charged.
#
# The artifacts it builds are instrumented: rebuild without `calibration`
# before using them for anything else.

set -euo pipefail

if [ ! -v NO_BUILD ]; then
    thruput build -p erc20 -- -F metadata
    thruput build -p swap-handler
    thruput build -p swap-router
    thruput build -p swap-factory
    # The instrumented one.
    thruput build -p swap-driver -- -F calibration
fi

artifact_root="$(realpath target/thruput)"
export THRUPUT_TESTKIT_ARTIFACT_ROOT="$artifact_root"

cargo test -p swap-router \
    --features calibration \
    --test calibration calibrate_crank_gas \
    -- \
    --ignored --no-capture
