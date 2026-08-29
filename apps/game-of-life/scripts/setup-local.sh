#!/usr/bin/env bash

set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
groundhog_cli="${GROUNDHOG_CLI:-groundhog}"

: "${GROUNDHOG_RUNTIME_MANIFEST:?Set GROUNDHOG_RUNTIME_MANIFEST to the active runtime manifest}"
: "${GROUNDHOG_CONTRACT_ADDRESS:?Set GROUNDHOG_CONTRACT_ADDRESS to the initialized Life contract}"
: "${GAME_OF_LIFE_INDEXER_URL:?Set GAME_OF_LIFE_INDEXER_URL to the loopback indexer origin}"
export GROUNDHOG_RPC_URL="${GROUNDHOG_RPC_URL:-http://127.0.0.1:9545}"
trap 'rm -f "$app_dir/.env.local"' ERR

for persona in dev-1 dev-2 dev-3; do
  "$groundhog_cli" airdrop "$persona" --amount 1000 --yes \
    --rpc-url "$GROUNDHOG_RPC_URL" \
    --runtime-manifest "$GROUNDHOG_RUNTIME_MANIFEST" >/dev/null
done

"$app_dir/node_modules/.bin/tsx" "$app_dir/scripts/setup-local.ts"
RUN_GAME_OF_LIFE_LOCAL_INTEGRATION=1 \
  "$app_dir/node_modules/.bin/vitest" run --mode local-integration \
  "$app_dir/src/integration/life.local.test.ts"
trap - ERR
