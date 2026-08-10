#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"

case "$("$groundhog_cli" --version)" in
  "groundhog 0.6.1") ;;
  *)
    printf 'Groundhog CLI 0.6.1 is required to build SDK 0.17.9 contract specs.\n' >&2
    exit 1
    ;;
esac

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
