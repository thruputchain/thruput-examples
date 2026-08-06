#!/bin/bash

# set CARGO_UNLOCK to omit --locked

set -euo pipefail

target="${TARGET:-rv32}"
build_args=(--target "$target")

groundhog_build() {
    echo "::group::groundhog build ${@}" &&
    groundhog build "${@}" &&
    echo "::endgroup::"
}

for pkg in $(cargo metadata --no-deps --format-version 1 | jq -r '.packages[] | select([.targets[].kind[]] | index("cdylib")) | .name'); do
    if [[ "$target" = "rv32" ]] && [[ "$pkg" = "swap-pair" ]]; then
        # Can't build swap for rv32 yet; use wasm
        groundhog_build -p "$pkg" --target "wasm" || {
            printf "Build (wasm) failed for contract %s\n" "$pkg"
            exit 1
        }
        continue
    fi

    cargo_args=()
    if [ -z "${CARGO_UNLOCK:-}" ]; then
        cargo_args+=(--locked)
    fi
    if [[ "$pkg" = "erc20" ]]; then
        cargo_args+=(-F metadata)
    fi

    # bash 3.2 (macOS) errors on "${empty_array[@]}" under `set -u`.
    extra=""
    if [[ "${#cargo_args[@]}" -gt 0 ]]; then
        extra="-- ${cargo_args[*]}"
    fi

    groundhog_build -p "$pkg" "${build_args[@]}" $extra || {
        printf "Build failed for contract %s\n" "$pkg"
        exit 1
    }
done
