#!/bin/bash

set -eu

target="${TARGET:-rv32}"
build_args=(--target "$target")

for pkg in $(cargo metadata --no-deps --format-version 1 | jq -r '.packages[] | select([.targets[].kind[]] | index("cdylib")) | .name'); do
    if [[ "$target" = "rv32" ]] && [[ "$pkg" = "swap" ]]; then
        # Can't build swap for rv32 yet
        continue
    fi

    echo "::group::groundhog build -p $pkg ${build_args[*]}"
    groundhog build -p "$pkg" "${build_args[@]}" || {
        printf "Build failed for contract %s\n" "$pkg"
        exit 1
    }
    echo "::endgroup::"
done
