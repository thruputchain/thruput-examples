#!/bin/bash

set -eu

target="${TARGET:-rv32}"
build_args=(--target "$target")

for pkg in $(cargo metadata --no-deps --format-version 1 | jq -r '.packages[] | select([.targets[].kind[]] | index("cdylib")) | .name'); do
    if [[ "$target" = "rv32" ]] && [[ "$pkg" = "swap-pair" ]]; then
        # Can't build swap for rv32 yet; use wasm
        echo "::group::groundhog build -p $pkg --target wasm"
        groundhog build -p "$pkg" --target "wasm" || {
            printf "Build (wasm) failed for contract %s\n" "$pkg"
            exit 1
        }
        echo "::endgroup::"
        continue
    fi

    extra_cargo_args=()
    if [[ "$pkg" = "erc20" ]]; then
        extra_cargo_args+=(-F metadata)
    fi

    echo "::group::groundhog build -p $pkg ${build_args[*]} -- ${extra_cargo_args[*]}"
    groundhog build -p "$pkg" "${build_args[@]}" -- "${extra_cargo_args[@]}" || {
        printf "Build failed for contract %s\n" "$pkg"
        exit 1
    }
    echo "::endgroup::"
done
