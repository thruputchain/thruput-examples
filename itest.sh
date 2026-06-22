#!/bin/sh

package="$1"

export GROUNDHOG_HOG_DEVNODE_BINARY=/home/repo/devnode/diagnostic/hog-devnode
  # export GROUNDHOG_HOG_DEVNODE_BINARY=/home/repo/devnode/v0.1.1-nightly.20260608/hog-devnode
  # export GROUNDHOG_HOG_DEVNODE_BINARY=/home/repo/devnode/v0.1.1-nightly.20260617/hog-devnode
  # export GROUNDHOG_HOG_DEVNODE_BINARY=/home/repo/devnode/v0.1.1-nightly.20260618/hog-devnode

hogd_protocol=(--hogd-protocol hogp/1cf254e7101b)
target=(--target wasm)
trace_cargo=(--show-cargo-commands)

# use a groundhog-cli in local development
groundhog() {
    cargo run \
        --manifest-path ~/gh/groundhog-rpc/crates/tools/cli/Cargo.toml \
        --bin groundhog \
        -- \
        "${trace_cargo[@]}" "${@}"
}

groundhog_integration_test() {
    groundhog test \
        "${hogd_protocol[@]}" \
        "${target[@]}" \
        --integration \
        --verbose \
        "${@}"
}

itest() {
    p="$1"

    groundhog build -p "$p" "${target[@]}"  &&
        groundhog_integration_test -p "$p"
}

itest "$package"

# Starting ephemeral local node for Rv32 integration tests...
# Deploying counter to http://127.0.0.1:38619 for integration tests...
# error: integration deploy did not produce a contract address: DeterministicError { kind: "unknown" }

# With added cli integration-test diagnostics:
  # error: integration deploy did not produce a contract address:
  # 	deploy failed with deterministic execution error (unknown)
  # 	  tx: 0x17fbccfb586260d45cd69c607d706223fac4292b34e24c31c77017f46e374d83
  # 	  height: 2
