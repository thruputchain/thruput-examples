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

lint "erc20 -F metadata"
# cargo clippy -p erc20 -F metadata -F dev
# cargo clippy -p erc20 -F metadata --target wasm32-unknown-unknown -F entrypoints

swap_packages="swap swap_driver swap_router"

for p in $swap_packages ; do
    lint "$p" || {
        echo "Lint failed for $p"
        return 1
    }
done
