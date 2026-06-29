#!/bin/bash

set -eu

target="${TARGET:?Please set TARGET=[wasm|rv32]}"
build_args=(--target "$target")

declare -A omit_build
if [[ "$target" = "rv32" ]]; then
    omit_build[swap]=1
fi

itest_contracts=(counter erc20)

set -x

RUST_FLAGS="-Dwarnings" \
    cargo test --all

for pkg in $(cargo metadata --no-deps --format-version 1 | jq -r '.packages[] | select([.targets[].kind[]] | index("cdylib")) | .name'); do
    [[ -n "${omit_build[$pkg]:-}" ]] && continue

    groundhog build -p "$pkg" "${build_args[@]}" || {
        printf "Build failed for contract %s\n" "$pkg"
        exit 1
    }
done

for pkg in "${itest_contracts[@]}"; do
    groundhog test --target "$target" --integration -p "$pkg" || {
        printf "Integration test failed for contract %s\n" "$pkg"
        exit 1
    }
done

cargo fmt --check

cargo clippy --workspace --all-targets --no-deps -- -D warnings

grep -q '\[patch' Cargo.toml && {
    echo "Cargo.toml has patched dependencies!"
    exit 1
}

printf "\nCI OKAY!\n"
