#!/bin/bash

# Build guest binaries.
#
# Set CARGO_UNLOCK to omit --locked

set -euo pipefail

target="${TARGET:-rv32}"
build_args=(--target "$target")

groundhog_build() {
    echo "::group::groundhog build ${@}" &&
    groundhog build "${@}" &&
    echo "::endgroup::"
}

# Contract crates expose a binary gated by the `entrypoints` feature.
contract_pkgs='.packages[] | select(any(.targets[]; (.kind | index("bin")) and ((.["required-features"] // []) | index("entrypoints")))) | .name'
contract_packages="$(cargo metadata --no-deps --format-version 1 | jq -r "$contract_pkgs")"

for pkg in ${contract_packages} ; do
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
