#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"
bash "$repo_root/scripts/check-groundhog-version.sh" "$("$groundhog_cli" --version)"
cd "$repo_root"
"$groundhog_cli" build -p counter
"$groundhog_cli" codegen ts target/groundhog/counter.spec.xdr -o apps/counter/src/contracts/generated/counter.ts
npx prettier --write apps/counter/src/contracts/generated/counter.ts
