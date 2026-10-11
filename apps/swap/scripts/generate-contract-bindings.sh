#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
thruput_cli="${THRUPUT_CLI:?Set THRUPUT_CLI to the validated CLI executable}"

cli_version="$("$thruput_cli" --version)"
bash "$repo_root/scripts/check-thruput-version.sh" "$cli_version"


(
  cd "$repo_root"
  "$thruput_cli" build -p erc20 -- -F metadata
  "$thruput_cli" build -p swap-factory
  "$thruput_cli" build -p swap-router
  "$thruput_cli" build -p swap-handler
  "$thruput_cli" build -p swap-driver

  "$thruput_cli" codegen ts target/thruput/erc20.spec.xdr \
    -o apps/swap/src/contracts/generated/erc20.ts
  "$thruput_cli" codegen ts target/thruput/swap_factory.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-factory.ts
  "$thruput_cli" codegen ts target/thruput/swap_handler.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-handler.ts
  "$thruput_cli" codegen ts target/thruput/swap_router.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-router.ts
  "$thruput_cli" codegen ts target/thruput/swap_driver.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-driver.ts

  npx prettier --write apps/swap/src/contracts/generated/*.ts
)
