#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"
: "${GROUNDHOG_RUNTIME_MANIFEST:?Set GROUNDHOG_RUNTIME_MANIFEST to verify the running node storage cost profile}"

export GROUNDHOG_CLI="$groundhog_cli"
export GROUNDHOG_RPC_URL="${GROUNDHOG_RPC_URL:-http://127.0.0.1:9545}"
export LAUNCHPAD_ARTIFACT_ROOT="${LAUNCHPAD_ARTIFACT_ROOT:-$repo_root/target/groundhog}"
export LAUNCHPAD_APP_ENV="${LAUNCHPAD_APP_ENV:-$app_dir/.env.local}"
export LAUNCHPAD_APP_PUBLIC_DIR="${LAUNCHPAD_APP_PUBLIC_DIR:-$app_dir/public}"

cli_version="$("$groundhog_cli" --version)"
bash "$repo_root/scripts/check-groundhog-version.sh" "$cli_version"

cd "$repo_root"
"$groundhog_cli" build -p standard-token -- --locked
"$groundhog_cli" build -p standard-token-factory -- --locked
"$app_dir/node_modules/.bin/tsx" "$app_dir/scripts/setup-local.ts"
