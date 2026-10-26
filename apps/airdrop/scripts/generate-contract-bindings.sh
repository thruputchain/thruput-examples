#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
cli="${THRUPUT_CLI:?Set THRUPUT_CLI to your local CLI executable}"
bash "$repo_root/scripts/check-thruput-version.sh" "$("$cli" --version)"
cd "$repo_root"
"$cli" build -p airdrop -- --locked
mkdir -p apps/airdrop/src/contracts/generated
"$cli" codegen ts target/thruput/airdrop.spec.xdr -o apps/airdrop/src/contracts/generated/airdrop.ts
npx --no-install prettier --write apps/airdrop/src/contracts/generated/airdrop.ts
