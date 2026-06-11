#!/bin/bash
# Run this script from the surrounding workspace

# For native tests:
#   cargo test -p swap
#   cargo test -p swap_driver
#   cargo test -p swap_router

set -xe

# Build wasms for use below
groundhog build -p erc20 -- -F metadata
groundhog build -p swap
groundhog build -p swap_driver
groundhog build -p swap_router

cargo test -p swap_driver -F wasm_test # -- --show-output
cargo test -p swap_router -F wasm_test # -- --show-output
