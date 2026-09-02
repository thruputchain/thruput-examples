#!/bin/bash

# Compile swap suite to guest binaries and run
# tests on those.

set -xeuo pipefail

# Build guest binaries for use below
groundhog build -p erc20 -- -F metadata
groundhog build -p swap-driver
groundhog build -p swap-router
groundhog build -p swap-handler
groundhog build -p swap-factory

cargo test -p swap-driver -F guest_test
cargo test -p swap-router -F guest_test
cargo test -p swap-factory -F guest_test
