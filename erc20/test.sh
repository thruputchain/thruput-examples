#!/bin/bash

set -euo pipefail

# Configuration

node_args=()
# node_args+=(--hogd-dev-binary ~/gh/hogd/build/hogd/hogd_dev/hogd-dev)
# node_args+=(--hogd-protocol hogp/5778ec23fb93)

erc20_admin_keyname="default"

# Routines

get_key() {
    groundhog keys --json ls |
        jq -re ".data.keys | map(select(.name == \"${erc20_admin_keyname}\"))[0].address"
}

node_start() {
    groundhog node "${node_args[@]}" &
    until nc -zv 127.0.0.1 9545 >& /dev/null ; do
        echo "Waiting for node to come up ..."
        sleep 3
    done
}

node_stop() {
    kill %groundhog &&
        wait %groundhog ||
        true
}

# Run

trap node_stop ERR
set -x

node_start
groundhog deploy # stores address in `groundhog.toml`
groundhog call erc20 initialize "$(get_key "$erc20_admin_keyname")"
groundhog call erc20 total_supply
node_stop
