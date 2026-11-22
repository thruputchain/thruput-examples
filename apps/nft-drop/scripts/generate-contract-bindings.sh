#!/usr/bin/env bash
# Build the drop and factory contracts and regenerate their TypeScript bindings.
# Use the artifacts and bindings from one run together.
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
thruput_cli="${THRUPUT_CLI:-thruput}"
bash "$repo_root/scripts/check-thruput-version.sh" "$("$thruput_cli" --version)"
cd "$repo_root"
generated=apps/nft-drop/src/contracts/generated
mkdir -p "$generated"
for contract in nft_drop nft_drop_factory; do
  "$thruput_cli" build -p "${contract//_/-}"
  "$thruput_cli" codegen ts "target/thruput/$contract.spec.xdr" -o "$generated/${contract//_/-}.ts"
done
npx prettier --write "$generated"
