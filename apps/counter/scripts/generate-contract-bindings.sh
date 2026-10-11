#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
thruput_cli="${THRUPUT_CLI:?Set THRUPUT_CLI to the validated CLI executable}"
bash "$repo_root/scripts/check-thruput-version.sh" "$("$thruput_cli" --version)"
cd "$repo_root"
"$thruput_cli" build -p counter
"$thruput_cli" codegen ts target/thruput/counter.spec.xdr -o apps/counter/src/contracts/generated/counter.ts
npx prettier --write apps/counter/src/contracts/generated/counter.ts
