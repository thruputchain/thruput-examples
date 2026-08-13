#!/bin/bash

# Run this script from the surrounding workspace

# For native tests, run e.g.:
#   cargo test -p swap-router

set -xeuo pipefail

# Build guest binaries for use below
build() {
    groundhog build -p erc20 -- -F metadata
    groundhog build -p swap-pair
    groundhog build -p swap-driver
    groundhog build -p swap-router
    groundhog build -p swap-handler
}

build

cargo test -p swap-driver -F guest_test -- --show-output
cargo test -p swap-router -F guest_test -- --show-output
