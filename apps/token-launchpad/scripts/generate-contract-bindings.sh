#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
thruput_cli="${THRUPUT_CLI:-thruput}"

cli_version="$("$thruput_cli" --version)"
bash "$repo_root/scripts/check-thruput-version.sh" "$cli_version"

mkdir -p "$app_dir/src/contracts/generated"

(
  cd "$repo_root"
  "$thruput_cli" build -p standard-token -- --locked
  "$thruput_cli" build -p standard-token-factory -- --locked
  "$thruput_cli" codegen ts target/thruput/standard_token.spec.xdr \
    --output apps/token-launchpad/src/contracts/generated/standard-token.ts
  "$thruput_cli" codegen ts target/thruput/standard_token_factory.spec.xdr \
    --output apps/token-launchpad/src/contracts/generated/standard-token-factory.ts
  npx --prefix apps/token-launchpad prettier --write \
    apps/token-launchpad/src/contracts/generated/*.ts
)
