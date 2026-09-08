#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"
dev_wallet_spec="$app_dir/specs/dev_wallet.spec.xdr"
dev_wallet_sha256="4e3d10d51600ad3b7f686766dd9a87795b32010b0b7665d69f33ef7d8ddd6fec"

cli_version="$("$groundhog_cli" --version)"
bash "$repo_root/scripts/check-groundhog-version.sh" "$cli_version"

actual_dev_wallet_sha256="$(shasum -a 256 "$dev_wallet_spec" | cut -d ' ' -f 1)"
if [[ "$actual_dev_wallet_sha256" != "$dev_wallet_sha256" ]]; then
  printf 'DevWallet spec checksum mismatch: expected %s, found %s.\n' \
    "$dev_wallet_sha256" "$actual_dev_wallet_sha256" >&2
  exit 1
fi

(
  cd "$repo_root"
  "$groundhog_cli" build -p erc20 -- -F metadata
  "$groundhog_cli" build -p swap-factory
  "$groundhog_cli" build -p swap-router
  "$groundhog_cli" build -p swap-handler
  "$groundhog_cli" build -p swap-driver

  "$groundhog_cli" codegen ts target/groundhog/erc20.spec.xdr \
    -o apps/swap/src/contracts/generated/erc20.ts
  "$groundhog_cli" codegen ts "$dev_wallet_spec" \
    -o apps/swap/src/contracts/generated/dev-wallet.ts
  "$groundhog_cli" codegen ts target/groundhog/swap_factory.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-factory.ts
  "$groundhog_cli" codegen ts target/groundhog/swap_handler.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-handler.ts
  "$groundhog_cli" codegen ts target/groundhog/swap_router.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-router.ts
  "$groundhog_cli" codegen ts target/groundhog/swap_driver.spec.xdr \
    -o apps/swap/src/contracts/generated/swap-driver.ts

  npx prettier --write apps/swap/src/contracts/generated/*.ts
)
