#!/bin/bash

set -euo pipefail

# Configuration

node_args=()
node_args+=(--port 0)
node_args+=(--hogd-dev-binary /home/repo/devnode/v0.1.1-nightly.20260608/hog-devnode)
node_args+=(--hogd-protocol hogp/7874f05decb9)

erc20_admin_keyname="default"

# Routines

node_start() {
    local work="$1"
    local out="$work/node.json"
    local err="$work/node.err"

    rm -f "$out"
    groundhog node "${node_args[@]}" --json > "$out" 2> "$err" &
    NODE_PID="$!"

    wait_for_node_json "$out" || {
        cat "$err" >&2 || true
        echo "Failed: local node did not emit startup JSON"
        return 1;
    }
}

wait_for_node_json() {
    local path="$1"
    local deadline=$((SECONDS + 30))
    while (( SECONDS < deadline )); do
        [[ -s "$path" ]] &&
            jq -e ".ok" <"$path" >/dev/null &&
            return 0
        sleep 0.2
    done
    return 1
}

node_stop() {
    if [[ -n "${NODE_PID:-}" ]]; then
        kill "${NODE_PID}" &&
            wait "${NODE_PID}" ||
            true
    fi
}

get_key() {
    groundhog keys --json ls |
        jq -re ".data.keys | map(select(.name == \"${erc20_admin_keyname}\"))[0].address"
}

cleanup() {
    node_stop
    rm -rf "$WORK"
}

write_groundhog_toml() {
    rpc_url=$(jq -r .data.rpc_url <"$NODE_JSON")

    cat >groundhog.toml <<TOML
[profile.default]
rpc_url = "http://localhost:9545"
default_key = "dev-0"

[profile.default.contracts]
# my-contract = "0x0000000000000000000000000000000000000000000000000000000000000000"

[profile.testnet]
rpc_url = "$rpc_url"
default_key = "default"

[profile.testnet.contracts]
# my-contract = "0x0000000000000000000000000000000000000000000000000000000000000000"
TOML
}

# Run

trap cleanup ERR
set -x

WORK="$(mktemp -d)"

node_start "$WORK"
# write_groundhog_toml
groundhog deploy --json # stores address in `groundhog.toml`
groundhog call erc20 initialize "$(get_key "$erc20_admin_keyname")"
groundhog call erc20 total_supply
node_stop
