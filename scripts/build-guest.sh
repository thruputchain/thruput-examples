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

# Contract crates are the ones that produce a guest binary. The lib
# crate-type is plain rlib, and the `entrypoints` feature is also declared by
# interface-only crates that have no bin, so the bin target is the marker.
contract_pkgs='.packages[] | select([.targets[].kind[]] | index("bin")) | .name'
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
