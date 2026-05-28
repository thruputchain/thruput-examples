#!/bin/bash
# Run this script from the surrounding workspace

set -xe

# Build wasms for use below
groundhog build -p erc20 -- -F metadata
groundhog build -p swap
groundhog build -p swap_driver -- -F metadata
groundhog build -p swap_router

# native test
cargo test -p swap_router -Fnative_test

# wasm test
cargo test -p swap_router
