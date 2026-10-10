#!/bin/bash

# Compile swap suite to guest binaries and run
# tests on those.

set -xeuo pipefail

# Build guest binaries for use below
thruput build -p erc20 -- -F metadata
thruput build -p swap-driver
thruput build -p swap-router
thruput build -p swap-handler
thruput build -p swap-factory

cargo test -p swap-driver -F guest_test
cargo test -p swap-router -F guest_test
cargo test -p swap-factory -F guest_test
