#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
thruput_cli="${THRUPUT_CLI:?Set THRUPUT_CLI to your local CLI executable}"
bash "$repo_root/scripts/check-thruput-version.sh" "$("$thruput_cli" --version)"
cd "$repo_root"
"$thruput_cli" build -p voting
mkdir -p apps/voting/src/contracts/generated
"$thruput_cli" codegen ts target/thruput/voting.spec.xdr -o apps/voting/src/contracts/generated/voting.ts
npx prettier --write apps/voting/src/contracts/generated/voting.ts
