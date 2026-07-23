#!/bin/bash

set -xeu

lint() {
    package="$1"

    cargo clippy -p $package \
        -F dev \
        -- -Dwarnings \
        &&

    cargo clippy -p $package \
        --release \
        --target wasm32-unknown-unknown \
        -F entrypoints \
        -- -Dwarnings
}

cargo clippy -p batch-driver -F dev -- -Dwarnings
cargo clippy -p batch-driver --release --target wasm32-unknown-unknown -- -Dwarnings

lint "erc20 -F metadata"

cargo clippy -p swap-if -- -Dwarnings
swap_packages="swap-pair swap-handler swap-driver swap-router swap-factory"
for p in $swap_packages ; do
    lint "$p" || {
        echo "Lint failed for $p"
        return 1
    }
done
