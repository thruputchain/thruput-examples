#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"

cli_version="$("$groundhog_cli" --version)"
if [[ ! "$cli_version" =~ ^groundhog\ ([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] ||
   (( BASH_REMATCH[1] == 0 && BASH_REMATCH[2] < 9 )); then
  printf 'Groundhog CLI 0.9.0 or newer is required to build SDK 0.19.0 contract specs; found %s.\n' "$cli_version" >&2
  exit 1
fi

(
  cd "$repo_root"
  "$groundhog_cli" build -p erc20 -- -F metadata
  "$groundhog_cli" build -p swap-factory
  "$groundhog_cli" build -p swap-router
  "$groundhog_cli" build -p swap-handler
  "$groundhog_cli" build -p swap-driver
  "$groundhog_cli" build -p swap-pair --target wasm

  "$groundhog_cli" codegen ts target/groundhog/erc20.spec.xdr \
    -o apps/swap/src/contracts/generated/erc20.ts
  "$groundhog_cli" codegen ts target/groundhog/swap_pair.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-pair.ts
  "$groundhog_cli" codegen ts target/groundhog/swap_router.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-router.ts
  "$groundhog_cli" codegen ts target/groundhog/swap_driver.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-driver.ts
)
