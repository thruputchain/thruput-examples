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

cargo clippy -p batch_driver -F dev -- -Dwarnings
cargo clippy -p batch_driver --release --target wasm32-unknown-unknown -- -Dwarnings

lint "erc20 -F metadata"

swap_packages="swap-pair swap-request swap-driver swap-router"
for p in $swap_packages ; do
    lint "$p" || {
        echo "Lint failed for $p"
        return 1
    }
done
