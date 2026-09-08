#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:-groundhog}"

cli_version="$("$groundhog_cli" --version)"
bash "$repo_root/scripts/check-groundhog-version.sh" "$cli_version"

mkdir -p "$app_dir/src/contracts/generated"

(
  cd "$repo_root"
  "$groundhog_cli" build -p standard-token -- --locked
  "$groundhog_cli" build -p standard-token-factory -- --locked
  "$groundhog_cli" codegen ts target/groundhog/standard_token.spec.xdr \
    --output apps/token-launchpad/src/contracts/generated/standard-token.ts
  "$groundhog_cli" codegen ts target/groundhog/standard_token_factory.spec.xdr \
    --output apps/token-launchpad/src/contracts/generated/standard-token-factory.ts
  npx --prefix apps/token-launchpad prettier --write \
    apps/token-launchpad/src/contracts/generated/*.ts
)
