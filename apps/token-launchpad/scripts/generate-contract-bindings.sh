#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:-groundhog}"

if [[ "$("$groundhog_cli" --version)" != "groundhog 0.10.4" ]]; then
  printf 'Groundhog CLI 0.10.4 is required.\n' >&2
  exit 1
fi

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
