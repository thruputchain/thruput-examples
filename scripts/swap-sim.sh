#!/bin/bash

# Requires `groundhog` (the cli) in PATH and an environment var:
#   GROUNDHOG_DEVNODE_BINARY=/path/to/hog-devnode

set -euo pipefail

for c in erc20 swap-request swap-driver swap-router; do groundhog build -p "$c"; done
groundhog build -p swap-pair --target wasm   # swap does not build for rv32a yet

# RUST_LOG="groundhog_node_supervisor=info,hogd_dev=info" \
GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$(realpath target/groundhog)" \
    cargo test -p swap-router --test testkit_sim -- --ignored --nocapture

