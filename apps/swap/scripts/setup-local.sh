#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"
export GROUNDHOG_CLI="$groundhog_cli"

: "${GROUNDHOG_RUNTIME_MANIFEST:?Set GROUNDHOG_RUNTIME_MANIFEST to the running node runtime manifest}"
export GROUNDHOG_RPC_URL="${GROUNDHOG_RPC_URL:-http://127.0.0.1:9545}"
export GROUNDHOG_TESTKIT_ARTIFACT_ROOT="$repo_root/target/groundhog"
export SWAP_APP_ENV="$app_dir/.env.local"
export SWAP_CLI_CONFIG_HOME="$app_dir/.groundhog-config"

cli_version="$("$groundhog_cli" --version)"
if [[ ! "$cli_version" =~ ^groundhog\ ([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] ||
   (( BASH_REMATCH[1] == 0 && BASH_REMATCH[2] < 9 )); then
  printf 'Groundhog CLI 0.9.0 or newer is required; found %s.\n' "$cli_version" >&2
  exit 1
fi

cd "$repo_root"
"$groundhog_cli" build -p erc20 -- -F metadata
"$groundhog_cli" build -p swap-factory
"$groundhog_cli" build -p swap-router
"$groundhog_cli" build -p swap-handler
"$groundhog_cli" build -p swap-driver
"$groundhog_cli" build -p swap-pair --target wasm
cargo run -p swap-setup
