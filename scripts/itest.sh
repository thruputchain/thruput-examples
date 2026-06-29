#!/bin/sh

set -eu

package="$1"

# export GROUNDHOG_DEVNODE_BINARY="/home/repo/devnode/v0.1.5/hog-devnode"
export GROUNDHOG_DEVNODE_BINARY="/home/repo/devnode/groundhog-client-0.1.7-linux-x86_64/bin/hog-devnode"

hogd_protocol=()
target=(--target rv32)

trace_cargo=()
integration_verbose=()

if [[ -v DIAGNOSTICS ]] then
    trace_cargo=(--show-cargo-commands)
    integration_verbose=(--verbose)
fi

# # use a groundhog-cli from source
# groundhog() {
#     cargo run \
#         --manifest-path ~/gh/groundhog-rpc/crates/tools/cli/Cargo.toml \
#         --bin groundhog \
#         -- \
#         "${trace_cargo[@]}" "${@}"
# }

groundhog_integration_test() {
    groundhog test \
        "${hogd_protocol[@]}" \
        "${target[@]}" \
        --integration \
        "${integration_verbose[@]}" \
        "${@}"
}

groundhog_integration_test -p "$package"
