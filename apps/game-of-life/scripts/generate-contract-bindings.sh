#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:?Set GROUNDHOG_CLI to the validated CLI executable}"
spec="$repo_root/target/groundhog/game_of_life.spec.xdr"

(
  cd "$repo_root"
  "$groundhog_cli" build -p game-of-life
  "$groundhog_cli" codegen ts "$spec" \
    -o apps/game-of-life/src/contracts/generated/game-of-life.ts
  npx prettier --write apps/game-of-life/src/contracts/generated/game-of-life.ts
)
