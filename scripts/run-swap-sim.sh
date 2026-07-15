#!/bin/bash

export GROUNDHOG_DEVNODE_BINARY="/home/repo/groundhog-client/v0.1.12/bin/hog-devnode"
export GROUNDHOG_TESTKIT_ARTIFACT_ROOT="/home/dbg/gh/groundhog-examples/target/groundhog/"

set -e

mv /tmp/node-err{,.prev} || true

cd /home/dbg/gh/groundhog-examples
cargo test -p swap_router --test testkit_sim -- --ignored --nocapture |& tee /tmp/node-err
