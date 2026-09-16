#!/bin/bash

# Measure what a crank actually costs on a devnode, to set the gas constants
# from.
#
# The mock harness the `guest_test` calibrations use charges noticeably less
# than a real node does, so constants set from it come out too small and
# requests fault for want of gas. This builds the driver with `calibration`,
# which makes `crank` report its own spending as a `GasReport` event, runs one
# request of each kind through a local node, and prints what it charged.
#
# The artifacts it builds are instrumented: rebuild without `calibration`
# before using them for anything else.

set -euo pipefail

if [ ! -v NO_BUILD ]; then
    groundhog build -p erc20 -- -F metadata
    groundhog build -p swap-handler
    groundhog build -p swap-router
    groundhog build -p swap-factory
    # The instrumented one.
    groundhog build -p swap-driver -- -F calibration
fi

artifact_root="$(realpath target/groundhog)"
export GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$artifact_root"

cargo test -p swap-router --features calibration --test testkit_sim calibrate_crank_gas \
    -- --ignored --nocapture
