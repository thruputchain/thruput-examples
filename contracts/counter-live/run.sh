#!/usr/bin/env bash

# Run from the repo root with the CLI version matching thruput-testkit.
set -euo pipefail
cd "$(dirname "$0")/../.." # the repository root

version="$(thruput --version)"
case "$version" in
    "thruput 0.48.0"|"thruput 0.48.0 "*) ;;
    *)
        printf 'Counter Testkit requires CLI 0.48.0; found %s.\n' "$version" >&2
        printf 'Install it with: cargo install --locked --version 0.48.0 thruput\n' >&2
        exit 1
        ;;
esac

thruput build -p counter
binary="$(thruput toolchain which)"
export THRUPUT_DEVNODE_BINARY="$binary"
export THRUPUT_TESTKIT_ARTIFACT_ROOT="$PWD/target/thruput"

cargo test -p counter-live --locked --test testkit_counter -- --ignored --nocapture
