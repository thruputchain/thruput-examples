#!/bin/bash
# Run this script from the surrounding workspace

# For native tests:
#   cargo test -p swap-pair
#   cargo test -p swap-driver
#   cargo test -p swap-router

set -xe

# Build wasms for use below
groundhog build -p erc20 -- -F metadata
groundhog build -p swap-pair
groundhog build -p swap-driver
groundhog build -p swap-router

cargo test -p swap-driver -F wasm_test # -- --show-output
cargo test -p swap-router -F wasm_test # -- --show-output
