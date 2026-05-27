#!/bin/bash

# Run this script from the surrounding workspace

groundhog build -p erc20 -- -F metadata
groundhog build -p swap
groundhog build -p swap_driver -- -F metadata
groundhog build -p swap_router

# cargo --config ".cargo/contract.toml" \
#     build \
#         -p swap_router \
#         --release \
#         --features entrypoints \
#         --target "wasm32-unknown-unknown"

# native test
cargo test -p swap_router -Fnative_test

# wasm test
cargo test -p swap_router
